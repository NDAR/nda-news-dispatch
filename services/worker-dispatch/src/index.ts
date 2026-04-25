import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  BatchGetCommand,
  BatchWriteCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import { SQSClient, SendMessageBatchCommand } from '@aws-sdk/client-sqs';
import { SchedulerClient, DeleteScheduleCommand } from '@aws-sdk/client-scheduler';

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

  // Defensive: if someone already dispatched (or cancelled) this campaign,
  // don't double-send. EventBridge can in rare failure modes re-fire a
  // one-time target.
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

  try {
    const recipients = await materializeRecipients({ tagMode, tags, excludeTags });
    if (recipients.length === 0) {
      await markStatus(id, 'failed', { sentAt: new Date().toISOString(), error: 'No recipients matched at dispatch time' });
      await deleteSchedule(id);
      return;
    }

    const now = new Date().toISOString();

    // Write RCPT items in batches of 25 (DDB BatchWrite limit).
    const rcptItems = recipients.map((email) => ({
      PutRequest: {
        Item: {
          PK: `CAMPAIGN#${id}`,
          SK: `RCPT#${email}`,
          GSI1PK: `RCPT#${email}`,
          GSI1SK: id,
          email,
          state: 'pending',
          queuedAt: now,
        },
      },
    }));
    await batchWrite(rcptItems);

    // Enqueue SQS messages in batches of 10 (SQS SendMessageBatch limit).
    let enqueued = 0;
    for (let i = 0; i < recipients.length; i += 10) {
      const chunk = recipients.slice(i, i + 10);
      await sqs.send(
        new SendMessageBatchCommand({
          QueueUrl: SEND_QUEUE_URL,
          Entries: chunk.map((email, idx) => ({
            Id: `${i + idx}`,
            MessageBody: JSON.stringify({ campaignId: id, email, subject, html }),
          })),
        }),
      );
      enqueued += chunk.length;
    }

    await markStatus(id, 'queued', { sentAt: now, recipients: recipients.length });

    // Initialize stats row idempotently.
    await ddb.send(
      new PutCommand({
        TableName: TABLE,
        Item: {
          PK: `CAMPAIGN#${id}`,
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
    ).catch(() => { /* already exists */ });

    console.log(JSON.stringify({ level: 'info', msg: 'dispatch-done', campaignId: id, enqueued }));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(JSON.stringify({ level: 'error', msg: 'dispatch-failed', campaignId: id, err: msg }));
    await markStatus(id, 'failed', { error: msg });
    // Re-throw so EventBridge records the failure in CloudWatch metrics.
    throw e;
  } finally {
    await deleteSchedule(id);
  }
}

// ── Recipient materialization (mirrors campaigns.ts) ───────────────────────

async function materializeRecipients(opts: {
  tagMode: 'all' | 'any';
  tags: string[];
  excludeTags: string[];
}): Promise<string[]> {
  const tagSets = await Promise.all(opts.tags.map((t) => queryTag(t)));
  const excludeSets = await Promise.all(opts.excludeTags.map((t) => queryTag(t)));
  const excluded = union(excludeSets);

  let base: Set<string>;
  if (tagSets.length === 0) base = await listAllActiveContacts();
  else if (opts.tagMode === 'all') base = intersect(tagSets);
  else base = union(tagSets);

  const candidates = [...base].filter((e) => !excluded.has(e));
  const profiles = await batchGetStatusAndSuppression(candidates);
  return candidates.filter((e) => {
    const p = profiles.get(e);
    return !!p && p.status === 'active' && !p.suppressed;
  });
}

async function queryTag(tag: string): Promise<Set<string>> {
  const out = new Set<string>();
  let cursor: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName: TABLE,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :pk',
        ExpressionAttributeValues: { ':pk': `TAG#${tag}` },
        ExclusiveStartKey: cursor,
      }),
    );
    for (const item of res.Items ?? []) out.add(String(item.email));
    cursor = res.LastEvaluatedKey;
  } while (cursor);
  return out;
}

async function listAllActiveContacts(): Promise<Set<string>> {
  const out = new Set<string>();
  let cursor: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(
      new ScanCommand({
        TableName: TABLE,
        FilterExpression: 'SK = :sk AND begins_with(PK, :p) AND #s = :active',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':sk': 'PROFILE', ':p': 'CONTACT#', ':active': 'active' },
        ExclusiveStartKey: cursor,
      }),
    );
    for (const item of res.Items ?? []) out.add(String(item.email));
    cursor = res.LastEvaluatedKey;
  } while (cursor);
  return out;
}

async function batchGetStatusAndSuppression(
  emails: string[],
): Promise<Map<string, { status: string; suppressed: boolean }>> {
  const out = new Map<string, { status: string; suppressed: boolean }>();
  if (emails.length === 0) return out;

  for (let i = 0; i < emails.length; i += 100) {
    const chunk = emails.slice(i, i + 100);
    const res = await ddb.send(
      new BatchGetCommand({
        RequestItems: {
          [TABLE]: {
            Keys: chunk.map((e) => ({ PK: `CONTACT#${e}`, SK: 'PROFILE' })),
          },
        },
      }),
    );
    for (const item of res.Responses?.[TABLE] ?? []) {
      out.set(String(item.email), { status: String(item.status ?? 'active'), suppressed: false });
    }
  }

  await Promise.all(
    emails.map(async (email) => {
      const res = await ddb.send(
        new QueryCommand({
          TableName: TABLE,
          KeyConditionExpression: 'PK = :pk',
          ExpressionAttributeValues: { ':pk': `SUPP#${email}` },
          Limit: 1,
        }),
      );
      if ((res.Count ?? 0) > 0) {
        const entry = out.get(email) ?? { status: 'active', suppressed: false };
        entry.suppressed = true;
        out.set(email, entry);
      }
    }),
  );
  return out;
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

function intersect(sets: Set<string>[]): Set<string> {
  if (sets.length === 0) return new Set();
  const [first, ...rest] = sets;
  const out = new Set<string>();
  for (const e of first) if (rest.every((s) => s.has(e))) out.add(e);
  return out;
}

function union(sets: Set<string>[]): Set<string> {
  const out = new Set<string>();
  for (const s of sets) for (const e of s) out.add(e);
  return out;
}

async function batchWrite(requests: { PutRequest?: unknown; DeleteRequest?: unknown }[]): Promise<void> {
  for (let i = 0; i < requests.length; i += 25) {
    const chunk = requests.slice(i, i + 25);
    if (chunk.length === 0) continue;
    await ddb.send(new BatchWriteCommand({ RequestItems: { [TABLE]: chunk as never[] } }));
  }
}

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}
