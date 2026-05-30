import type { SQSHandler, SQSBatchResponse, SQSRecord } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { SQSClient, type SendMessageBatchRequestEntry } from '@aws-sdk/client-sqs';
import {
  batchWriteAll,
  materializeAudienceEmails,
  sendMessageBatchAll,
} from '../../../packages/shared/src';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const sqs = new SQSClient({});

const TABLE = mustEnv('TABLE_NAME');
const SEND_QUEUE_URL = mustEnv('SEND_QUEUE_URL');

interface EnqueueJob {
  campaignId: string;
}

/**
 * SQS-triggered orchestrator. One message per campaign — runs materialize +
 * per-recipient RCPT writes + per-recipient SQS push to the send queue. Lives
 * in its own Lambda (15-min timeout) so 50K-row campaigns don't bump against
 * the 60s API Gateway / scheduler limits.
 *
 * Idempotency: if the campaign is already past `queueing` (e.g. SQS retried
 * after we'd finished), we skip. Mid-flight retries will re-write RCPT rows
 * (idempotent) and may double-enqueue send messages — accepted trade-off vs.
 * a per-recipient cursor. SES SendEmail does not de-duplicate, so a true
 * crash-during-send retry could yield duplicate sends; tune `maxReceiveCount`
 * accordingly on the enqueue queue.
 */
export const handler: SQSHandler = async (event) => {
  const failures: SQSBatchResponse['batchItemFailures'] = [];
  for (const record of event.Records) {
    try {
      await processRecord(record);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(JSON.stringify({ level: 'error', msg: 'enqueue-failed', messageId: record.messageId, err: msg }));
      failures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures: failures };
};

async function processRecord(record: SQSRecord): Promise<void> {
  const job = JSON.parse(record.body) as EnqueueJob;
  const id = job.campaignId;
  if (!id) throw new Error('missing campaignId');
  console.log(JSON.stringify({ level: 'info', msg: 'enqueue-start', campaignId: id }));

  const meta = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: { PK: `CAMPAIGN#${id}`, SK: 'META' } }),
  );
  if (!meta.Item) throw new Error(`campaign ${id} not found`);

  const status = String(meta.Item.status ?? '');
  if (status === 'queued' || status === 'sending' || status === 'simulated') {
    // Either a duplicate enqueue trigger or a successful prior run — skip.
    console.warn(JSON.stringify({ level: 'warn', msg: 'enqueue-already-done', campaignId: id, status }));
    return;
  }
  if (status !== 'queueing') {
    throw new Error(`campaign ${id} in unexpected status "${status}", expected "queueing"`);
  }

  const tagMode = (meta.Item.tagMode as 'all' | 'any') ?? 'all';
  const tags = (meta.Item.tags as string[] | undefined) ?? [];
  const excludeTags = (meta.Item.excludeTags as string[] | undefined) ?? [];
  const typeId = typeof meta.Item.typeId === 'string' ? meta.Item.typeId : undefined;
  // Dry-run flag persisted by the API at draft → queueing transition. When
  // true, we still materialize the audience and write RCPT rows so the
  // History page can show what *would* have shipped, but we skip the
  // per-recipient SQS push — worker-send is never invoked for this campaign.
  const simulated = meta.Item.simulated === true;
  const claimedAt = new Date().toISOString();

  try {
    const recipients = await materializeAudienceEmails(ddb, TABLE, { tagMode, tags, excludeTags, typeId });
    if (recipients.length === 0) {
      await markStatus(id, 'failed', { sentAt: claimedAt, error: 'No recipients matched at send time' });
      return;
    }

    await createStatsRow(id);
    await batchWriteAll(
      ddb,
      TABLE,
      buildRecipientRows(id, recipients, claimedAt, simulated ? 'simulated' : 'pending'),
    );
    if (simulated) {
      await markStatus(id, 'simulated', { sentAt: claimedAt, recipients: recipients.length });
      console.log(JSON.stringify({ level: 'info', msg: 'enqueue-simulated', campaignId: id, recipients: recipients.length }));
      return;
    }
    const enqueued = await enqueueSendMessages(id, recipients);
    await markStatus(id, 'queued', { sentAt: claimedAt, recipients: recipients.length });

    console.log(JSON.stringify({ level: 'info', msg: 'enqueue-done', campaignId: id, enqueued }));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await markStatus(id, 'failed', { sentAt: claimedAt, error: msg });
    throw e;
  }
}

async function markStatus(
  id: string,
  status: 'queued' | 'failed' | 'simulated',
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
  state: 'pending' | 'simulated' = 'pending',
): { PutRequest?: unknown; DeleteRequest?: unknown }[] {
  return recipients.map((email) => ({
    PutRequest: {
      Item: {
        PK: `CAMPAIGN#${campaignId}`,
        SK: `RCPT#${email}`,
        GSI1PK: `RCPT#${email}`,
        GSI1SK: campaignId,
        email,
        state,
        queuedAt,
      },
    },
  }));
}

async function enqueueSendMessages(campaignId: string, recipients: string[]): Promise<number> {
  const entries: SendMessageBatchRequestEntry[] = recipients.map((email, index) => ({
    Id: `${index}`,
    MessageBody: JSON.stringify({ campaignId, email }),
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
          UpdateExpression: 'SET #s = :s, error = :e, failedAt = :t',
          ExpressionAttributeNames: { '#s': 'state' },
          ExpressionAttributeValues: { ':s': 'failed', ':e': message, ':t': at },
        }),
      ),
    ),
  );
}

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}
