import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { SQSClient, type SendMessageBatchRequestEntry } from '@aws-sdk/client-sqs';
import { SchedulerClient, DeleteScheduleCommand } from '@aws-sdk/client-scheduler';
import {
  batchWriteAll,
  materializeAudienceEmails,
  sendMessageBatchAll,
} from '../../../packages/shared/src';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const sqs = new SQSClient({});
const scheduler = new SchedulerClient({});

const TABLE = mustEnv('TABLE_NAME');
const SEND_QUEUE_URL = mustEnv('SEND_QUEUE_URL');
const SCHEDULE_GROUP = process.env.SCHEDULE_GROUP_NAME;

interface DispatchEvent {
  campaignId: string;
}

/**
 * EventBridge Scheduler target. Fires once at the campaign's scheduled time
 * and runs the same materialize-and-enqueue logic that
 * `POST /admin/campaigns/{id}/send` runs for an immediate send.
 *
 * The schedule itself is one-shot, but EventBridge does not auto-clean
 * one-time schedules — we delete it ourselves once dispatch completes (or
 * fails irrecoverably) so the schedule group doesn't accumulate cruft.
 */
export async function handler(event: DispatchEvent): Promise<void> {
  const id = event?.campaignId;
  if (!id) {
    console.error(JSON.stringify({ level: 'error', msg: 'missing-campaign-id', event }));
    return;
  }
  console.log(JSON.stringify({ level: 'info', msg: 'dispatch-start', campaignId: id }));

  const meta = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: { PK: `CAMPAIGN#${id}`, SK: 'META' } }),
  );
  if (!meta.Item) {
    console.error(JSON.stringify({ level: 'error', msg: 'campaign-not-found', campaignId: id }));
    await deleteSchedule(id);
    return;
  }

  const status = meta.Item.status as string;
  if (status !== 'scheduled') {
    console.warn(JSON.stringify({
      level: 'warn',
      msg: 'skipping-non-scheduled',
      campaignId: id,
      status,
    }));
    await deleteSchedule(id);
    return;
  }

  const tagMode = (meta.Item.tagMode as 'all' | 'any') ?? 'all';
  const tags = (meta.Item.tags as string[] | undefined) ?? [];
  const excludeTags = (meta.Item.excludeTags as string[] | undefined) ?? [];
  const subject = String(meta.Item.subject);
  const html = String(meta.Item.html);
  const claimedAt = new Date().toISOString();

  try {
    await claimScheduledDispatch(id);
  } catch (e) {
    if (isConditionalFailure(e)) {
      console.warn(JSON.stringify({ level: 'warn', msg: 'dispatch-already-claimed', campaignId: id }));
      await deleteSchedule(id);
      return;
    }
    throw e;
  }

  try {
    const recipients = await materializeAudienceEmails(ddb, TABLE, { tagMode, tags, excludeTags });
    if (recipients.length === 0) {
      await markStatus(id, 'failed', {
        sentAt: claimedAt,
        error: 'No recipients matched at dispatch time',
      });
      await deleteSchedule(id);
      return;
    }

    await createStatsRow(id);
    await batchWriteAll(ddb, TABLE, buildRecipientRows(id, recipients, claimedAt));
    const enqueued = await enqueueCampaignMessages(id, recipients, subject, html);
    await markStatus(id, 'queued', { sentAt: claimedAt, recipients: recipients.length });

    console.log(JSON.stringify({ level: 'info', msg: 'dispatch-done', campaignId: id, enqueued }));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(JSON.stringify({ level: 'error', msg: 'dispatch-failed', campaignId: id, err: msg }));
    await markStatus(id, 'failed', { sentAt: claimedAt, error: msg });
    // Re-throw so EventBridge records the failure in CloudWatch metrics.
    throw e;
  } finally {
    await deleteSchedule(id);
  }
}

// ── Status + cleanup ───────────────────────────────────────────────────────

async function markStatus(
  id: string,
  status: 'queued' | 'failed',
  extras: { sentAt?: string; recipients?: number; error?: string } = {},
): Promise<void> {
  const parts = ['#s = :s', 'GSI1PK = :gpk'];
  const values: Record<string, unknown> = { ':s': status, ':gpk': `STATUS#${status}` };
  const names: Record<string, string> = { '#s': 'status' };
  if (extras.sentAt) { parts.push('sentAt = :sa'); values[':sa'] = extras.sentAt; }
  if (extras.recipients !== undefined) { parts.push('recipients = :r'); values[':r'] = extras.recipients; }
  if (extras.error) { parts.push('#e = :e'); values[':e'] = extras.error; names['#e'] = 'error'; }
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { PK: `CAMPAIGN#${id}`, SK: 'META' },
      UpdateExpression: 'SET ' + parts.join(', '),
      ExpressionAttributeValues: values,
      ExpressionAttributeNames: names,
    }),
  );
}

async function deleteSchedule(campaignId: string): Promise<void> {
  if (!SCHEDULE_GROUP) return;
  try {
    await scheduler.send(
      new DeleteScheduleCommand({
        Name: scheduleName(campaignId),
        GroupName: SCHEDULE_GROUP,
      }),
    );
  } catch (e) {
    // ResourceNotFound is fine — already gone.
    console.warn(JSON.stringify({ level: 'warn', msg: 'schedule-delete-failed', campaignId, err: String(e) }));
  }
}

export function scheduleName(campaignId: string): string {
  return `dispatch-${campaignId}`;
}

// ── Helpers ────────────────────────────────────────────────────────────────

async function claimScheduledDispatch(campaignId: string): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { PK: `CAMPAIGN#${campaignId}`, SK: 'META' },
      UpdateExpression: 'SET #s = :s, GSI1PK = :gpk',
      ConditionExpression: '#s = :scheduled',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: {
        ':s': 'sending',
        ':gpk': 'STATUS#sending',
        ':scheduled': 'scheduled',
      },
    }),
  );
}

async function createStatsRow(campaignId: string): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        PK: `CAMPAIGN#${campaignId}`,
        SK: 'STATS',
        delivered: 0,
        opened: 0,
        clicked: 0,
        bounced: 0,
        complained: 0,
        unsubscribed: 0,
      },
      ConditionExpression: 'attribute_not_exists(PK)',
    }),
  ).catch(() => undefined);
}

function buildRecipientRows(
  campaignId: string,
  recipients: string[],
  queuedAt: string,
): { PutRequest?: unknown; DeleteRequest?: unknown }[] {
  return recipients.map((email) => ({
    PutRequest: {
      Item: {
        PK: `CAMPAIGN#${campaignId}`,
        SK: `RCPT#${email}`,
        GSI1PK: `RCPT#${email}`,
        GSI1SK: campaignId,
        email,
        state: 'pending',
        queuedAt,
      },
    },
  }));
}

async function enqueueCampaignMessages(
  campaignId: string,
  recipients: string[],
  subject: string,
  html: string,
): Promise<number> {
  const entries: SendMessageBatchRequestEntry[] = recipients.map((email, index) => ({
    Id: `${index}`,
    MessageBody: JSON.stringify({ campaignId, email, subject, html }),
  }));
  const result = await sendMessageBatchAll(sqs, SEND_QUEUE_URL, entries);
  if (result.failed.length > 0) {
    await markRecipientEnqueueFailures(
      campaignId,
      result.failed.map((failure) => ({
        email: recipients[Number(failure.entry.Id)],
        message: failure.message ?? failure.code ?? 'SQS enqueue failed',
      })),
    );
    throw new Error(`Failed to enqueue ${result.failed.length} recipient(s)`);
  }
  return result.successful.length;
}

async function markRecipientEnqueueFailures(
  campaignId: string,
  failures: { email: string; message: string }[],
): Promise<void> {
  const at = new Date().toISOString();
  await Promise.all(
    failures.map(({ email, message }) =>
      ddb.send(
        new UpdateCommand({
          TableName: TABLE,
          Key: { PK: `CAMPAIGN#${campaignId}`, SK: `RCPT#${email}` },
          UpdateExpression: 'SET #s = :s, failedAt = :at, #e = :e',
          ExpressionAttributeNames: { '#s': 'state', '#e': 'error' },
          ExpressionAttributeValues: { ':s': 'failed', ':at': at, ':e': message },
        }),
      ),
    ),
  );
}

function isConditionalFailure(err: unknown): boolean {
  return (err as { name?: string }).name === 'ConditionalCheckFailedException';
}

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}
