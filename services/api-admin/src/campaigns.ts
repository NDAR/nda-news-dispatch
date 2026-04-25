import type { APIGatewayProxyHandler, APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  BatchWriteCommand,
  BatchGetCommand,
} from '@aws-sdk/lib-dynamodb';
import { SQSClient, SendMessageBatchCommand } from '@aws-sdk/client-sqs';
import {
  SchedulerClient,
  CreateScheduleCommand,
  DeleteScheduleCommand,
  FlexibleTimeWindowMode,
} from '@aws-sdk/client-scheduler';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const sqs = new SQSClient({});
const scheduler = new SchedulerClient({});

const TABLE = mustEnv('TABLE_NAME');
const SEND_QUEUE_URL = mustEnv('SEND_QUEUE_URL');
// Scheduling-related env vars are optional in dev so the handler still works
// before the scheduler infra has been deployed; we error on actual schedule
// creation if any are missing.
const SCHEDULE_GROUP = process.env.SCHEDULE_GROUP_NAME;
const SCHEDULE_EXEC_ROLE_ARN = process.env.SCHEDULE_EXEC_ROLE_ARN;
const DISPATCH_FN_ARN = process.env.DISPATCH_FN_ARN;

// Minimum lead time for scheduled sends. EventBridge accepts schedules with
// near-zero lead time, but a small buffer prevents the schedule from firing
// before our DDB transaction has committed across replicas.
const MIN_SCHEDULE_LEAD_MS = 60_000;

const TAG_RE = /^[a-z0-9-]{1,40}$/;

export const handler: APIGatewayProxyHandler = async (event) => {
  try {
    const route = `${event.httpMethod} ${event.resource}`;
    switch (route) {
      case 'GET /admin/campaigns':
        return ok(await listCampaigns(event));
      case 'POST /admin/campaigns':
        return ok(await createCampaign(parseBody(event), claimsOf(event)));
      case 'GET /admin/campaigns/{id}':
        return ok(await getCampaign(path(event, 'id')));
      case 'DELETE /admin/campaigns/{id}':
        return ok(await deleteCampaign(path(event, 'id')));
      case 'POST /admin/campaigns/{id}/send':
        return ok(await sendCampaign(path(event, 'id'), parseBody(event), claimsOf(event)));
      case 'POST /admin/campaigns/{id}/cancel':
        return ok(await cancelScheduledCampaign(path(event, 'id')));
      default:
        return err(404, 'not-found', `No route for ${route}`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(JSON.stringify({ level: 'error', msg }));
    if (e instanceof HttpError) return err(e.status, e.code, e.message);
    return err(500, 'internal-error', 'Unexpected server error');
  }
};

// ── Campaign operations ────────────────────────────────────────────────────

interface CampaignInput {
  templateId?: string;
  name?: string;
  subject?: string;
  html?: string;
}

interface SendInput {
  tagMode?: 'all' | 'any';
  tags?: string[];
  excludeTags?: string[];
  testOnly?: boolean;
  /** ISO-8601 UTC. If present, schedule the send instead of dispatching now. */
  scheduleAt?: string;
}

interface CampaignRecord {
  id: string;
  name: string;
  templateId?: string;
  templateVersion?: number;
  subject: string;
  html: string;
  status: 'draft' | 'scheduled' | 'queued' | 'sending' | 'sent' | 'failed';
  recipients: number;
  tags: string[];
  excludeTags: string[];
  tagMode: 'all' | 'any';
  createdAt: string;
  createdBy?: string;
  sentAt?: string;
  scheduleAt?: string;
}

async function listCampaigns(event: APIGatewayProxyEvent): Promise<{ items: CampaignRecord[] }> {
  const status = event.queryStringParameters?.status;
  const pk = status ? `STATUS#${status}` : 'STATUS#draft';
  const res = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk',
      ExpressionAttributeValues: { ':pk': pk },
      ScanIndexForward: false,
      Limit: 100,
    }),
  );
  return { items: (res.Items ?? []).map(stripKeys) as CampaignRecord[] };
}

async function getCampaign(id: string): Promise<CampaignRecord & { stats: Record<string, number> }> {
  const [meta, stats] = await Promise.all([
    ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: `CAMPAIGN#${id}`, SK: 'META' } })),
    ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: `CAMPAIGN#${id}`, SK: 'STATS' } })),
  ]);
  if (!meta.Item) throw new HttpError(404, 'not-found', `Campaign ${id} not found`);
  return {
    ...(stripKeys(meta.Item) as CampaignRecord),
    stats: (stats.Item ? stripKeys(stats.Item) : {}) as Record<string, number>,
  };
}

async function createCampaign(input: CampaignInput, claims: Claims): Promise<CampaignRecord> {
  const id = randomUUID();
  const now = new Date().toISOString();
  let subject = (input.subject ?? '').trim();
  let html = input.html ?? '';
  let templateVersion: number | undefined;

  if (input.templateId) {
    const t = await ddb.send(
      new GetCommand({ TableName: TABLE, Key: { PK: `TEMPLATE#${input.templateId}`, SK: 'LATEST' } }),
    );
    if (!t.Item) throw new HttpError(404, 'template-not-found', `Template ${input.templateId} not found`);
    subject = subject || String(t.Item.subject ?? '');
    html = html || String(t.Item.html ?? '');
    templateVersion = t.Item.version as number;
  }

  if (!subject) throw new HttpError(400, 'invalid-input', 'subject is required');
  if (!html) throw new HttpError(400, 'invalid-input', 'html is required');

  const record: CampaignRecord = {
    id,
    name: (input.name ?? '').trim() || 'Untitled campaign',
    templateId: input.templateId,
    templateVersion,
    subject,
    html,
    status: 'draft',
    recipients: 0,
    tags: [],
    excludeTags: [],
    tagMode: 'all',
    createdAt: now,
    createdBy: claims.email ?? claims.sub,
  };

  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: toGsiItem(record),
    }),
  );
  return record;
}

async function deleteCampaign(id: string): Promise<{ id: string; deleted: true }> {
  const existing = await getCampaign(id).catch(() => null);
  if (!existing) throw new HttpError(404, 'not-found', `Campaign ${id} not found`);
  if (existing.status !== 'draft') {
    throw new HttpError(409, 'illegal-state', 'Only drafts can be deleted');
  }
  await ddb.send(
    new BatchWriteCommand({
      RequestItems: {
        [TABLE]: [
          { DeleteRequest: { Key: { PK: `CAMPAIGN#${id}`, SK: 'META' } } },
          { DeleteRequest: { Key: { PK: `CAMPAIGN#${id}`, SK: 'STATS' } } },
        ] as never[],
      },
    }),
  );
  return { id, deleted: true };
}

async function sendCampaign(
  id: string,
  input: SendInput,
  claims: Claims,
): Promise<{ id: string; status: string; enqueued: number; scheduleAt?: string }> {
  const meta = await ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: `CAMPAIGN#${id}`, SK: 'META' } }));
  if (!meta.Item) throw new HttpError(404, 'not-found', `Campaign ${id} not found`);
  if (meta.Item.status !== 'draft') {
    throw new HttpError(409, 'illegal-state', `Campaign is already ${meta.Item.status}`);
  }

  const tagMode = input.tagMode === 'any' ? 'any' : 'all';
  const tags = validTags(input.tags);
  const excludeTags = validTags(input.excludeTags);
  const testOnly = !!input.testOnly;

  // ── Scheduled branch ────────────────────────────────────────────────────
  // We persist the filter on the META row so the dispatch worker can rebuild
  // the audience at fire time (membership may change between scheduling and
  // dispatch — new subscribers should be included, unsubscribes excluded).
  if (input.scheduleAt && !testOnly) {
    const scheduleAt = validateScheduleAt(input.scheduleAt);
    if (!SCHEDULE_GROUP || !SCHEDULE_EXEC_ROLE_ARN || !DISPATCH_FN_ARN) {
      throw new HttpError(503, 'scheduler-unconfigured', 'Scheduled sends are not enabled in this environment');
    }

    // Persist the schedule + filter onto the META row first. If schedule
    // creation fails afterwards we'll roll the status back.
    const sentBy = claims.email ?? claims.sub ?? 'unknown';
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { PK: `CAMPAIGN#${id}`, SK: 'META' },
        UpdateExpression:
          'SET #s = :s, tags = :t, excludeTags = :x, tagMode = :m, GSI1PK = :gpk, scheduleAt = :sched, scheduledBy = :sb',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: {
          ':s': 'scheduled',
          ':t': tags,
          ':x': excludeTags,
          ':m': tagMode,
          ':gpk': 'STATUS#scheduled',
          ':sched': scheduleAt,
          ':sb': sentBy,
        },
      }),
    );

    try {
      await scheduler.send(
        new CreateScheduleCommand({
          Name: `dispatch-${id}`,
          GroupName: SCHEDULE_GROUP,
          ScheduleExpression: `at(${scheduleAt.replace(/\.\d{3}Z$/, '').replace(/Z$/, '')})`,
          ScheduleExpressionTimezone: 'UTC',
          FlexibleTimeWindow: { Mode: FlexibleTimeWindowMode.OFF },
          ActionAfterCompletion: 'NONE',
          Target: {
            Arn: DISPATCH_FN_ARN,
            RoleArn: SCHEDULE_EXEC_ROLE_ARN,
            Input: JSON.stringify({ campaignId: id }),
          },
        }),
      );
    } catch (e) {
      // Roll the campaign back to draft so the user can retry without
      // having to manually clean up DDB state.
      await ddb.send(
        new UpdateCommand({
          TableName: TABLE,
          Key: { PK: `CAMPAIGN#${id}`, SK: 'META' },
          UpdateExpression: 'SET #s = :s, GSI1PK = :gpk REMOVE scheduleAt, scheduledBy',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: {
            ':s': 'draft',
            ':gpk': 'STATUS#draft',
          },
        }),
      ).catch(() => undefined);
      throw e;
    }

    return { id, status: 'scheduled', enqueued: 0, scheduleAt };
  }

  // ── Immediate-send branch (existing behavior) ───────────────────────────
  const recipients = await materializeRecipients({ tagMode, tags, excludeTags });
  if (recipients.length === 0) throw new HttpError(400, 'empty-audience', 'No recipients match the filters');

  const subject = String(meta.Item.subject);
  const html = String(meta.Item.html);
  const now = new Date().toISOString();

  // Write RCPT items (25/batch), then enqueue SQS messages (10/batch).
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

  let enqueued = 0;
  if (!testOnly) {
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
  }

  const nextStatus = testOnly ? 'draft' : 'queued';
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { PK: `CAMPAIGN#${id}`, SK: 'META' },
      UpdateExpression:
        'SET #s = :s, recipients = :r, tags = :t, excludeTags = :x, tagMode = :m, GSI1PK = :gpk, sentAt = :sa, sentBy = :sb',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: {
        ':s': nextStatus,
        ':r': recipients.length,
        ':t': tags,
        ':x': excludeTags,
        ':m': tagMode,
        ':gpk': `STATUS#${nextStatus}`,
        ':sa': now,
        ':sb': claims.email ?? claims.sub ?? 'unknown',
      },
    }),
  );

  // Initialize stats row (idempotent).
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

  return { id, status: nextStatus, enqueued };
}

/**
 * Cancels a scheduled campaign by deleting its EventBridge schedule and
 * reverting the META row to 'draft'. No-op if the campaign isn't scheduled.
 */
async function cancelScheduledCampaign(id: string): Promise<{ id: string; status: 'draft' }> {
  const meta = await ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: `CAMPAIGN#${id}`, SK: 'META' } }));
  if (!meta.Item) throw new HttpError(404, 'not-found', `Campaign ${id} not found`);
  if (meta.Item.status !== 'scheduled') {
    throw new HttpError(409, 'illegal-state', `Campaign is ${meta.Item.status}, not scheduled`);
  }
  if (SCHEDULE_GROUP) {
    await scheduler.send(
      new DeleteScheduleCommand({ Name: `dispatch-${id}`, GroupName: SCHEDULE_GROUP }),
    ).catch((e) => {
      // ResourceNotFound means the schedule fired (or was already cleaned up).
      // Either way we can safely revert the campaign to draft.
      console.warn(JSON.stringify({ level: 'warn', msg: 'cancel-schedule-delete-failed', id, err: String(e) }));
    });
  }
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { PK: `CAMPAIGN#${id}`, SK: 'META' },
      UpdateExpression: 'SET #s = :s, GSI1PK = :gpk REMOVE scheduleAt, scheduledBy',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':s': 'draft', ':gpk': 'STATUS#draft' },
    }),
  );
  return { id, status: 'draft' };
}

function validateScheduleAt(input: string): string {
  const t = Date.parse(input);
  if (Number.isNaN(t)) throw new HttpError(400, 'invalid-schedule', 'scheduleAt must be a valid ISO timestamp');
  if (t < Date.now() + MIN_SCHEDULE_LEAD_MS) {
    throw new HttpError(400, 'invalid-schedule', 'scheduleAt must be at least 1 minute in the future');
  }
  return new Date(t).toISOString();
}

// ── Recipient materialization ──────────────────────────────────────────────

async function materializeRecipients(opts: {
  tagMode: 'all' | 'any';
  tags: string[];
  excludeTags: string[];
}): Promise<string[]> {
  const tagSets = await Promise.all(opts.tags.map((t) => queryTag(t)));
  const excludeSets = await Promise.all(opts.excludeTags.map((t) => queryTag(t)));
  const excluded = union(excludeSets);

  let base: Set<string>;
  if (tagSets.length === 0) {
    // No tag filter → all active contacts. Only used for small lists;
    // larger sends should always specify filters.
    base = await listAllActiveContacts();
  } else if (opts.tagMode === 'all') {
    base = intersect(tagSets);
  } else {
    base = union(tagSets);
  }

  const candidates = [...base].filter((e) => !excluded.has(e));

  // Filter out inactive + suppressed.
  const profiles = await batchGetStatusAndSuppression(candidates);
  return candidates.filter((e) => {
    const p = profiles.get(e);
    if (!p) return false;
    if (p.status !== 'active') return false;
    if (p.suppressed) return false;
    return true;
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
  // NOTE: uses Scan for simplicity; migrate to a by-status GSI when list grows.
  const { ScanCommand } = await import('@aws-sdk/lib-dynamodb');
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

  // Profiles.
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

  // Suppression markers (one query per email — fine for MVP audiences).
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

// ── Helpers ────────────────────────────────────────────────────────────────

function toGsiItem(c: CampaignRecord): Record<string, unknown> {
  return {
    PK: `CAMPAIGN#${c.id}`,
    SK: 'META',
    GSI1PK: `STATUS#${c.status}`,
    GSI1SK: c.createdAt,
    ...c,
  };
}

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

function stripKeys(item: Record<string, unknown>): Record<string, unknown> {
  const { PK, SK, GSI1PK, GSI1SK, ...rest } = item as Record<string, unknown>;
  void PK; void SK; void GSI1PK; void GSI1SK;
  return rest;
}

function validTags(v: string[] | undefined): string[] {
  if (!v) return [];
  const out = [...new Set(v.map((t) => t.trim().toLowerCase()))];
  for (const t of out) {
    if (!TAG_RE.test(t)) throw new HttpError(400, 'invalid-tag', `Invalid tag: ${t}`);
  }
  return out;
}

function parseBody<T = Record<string, unknown>>(event: APIGatewayProxyEvent): T {
  if (!event.body) return {} as T;
  try {
    return JSON.parse(event.body) as T;
  } catch {
    throw new HttpError(400, 'invalid-json', 'Request body must be valid JSON');
  }
}

function path(event: APIGatewayProxyEvent, key: string): string {
  const v = event.pathParameters?.[key];
  if (!v) throw new HttpError(400, 'missing-path', `Path parameter "${key}" required`);
  return v;
}

type Claims = { sub?: string; email?: string };
function claimsOf(event: APIGatewayProxyEvent): Claims {
  const c = (event.requestContext.authorizer?.claims ?? {}) as Record<string, string>;
  return { sub: c.sub, email: c.email };
}

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function ok(data: unknown): APIGatewayProxyResult {
  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(data),
  };
}

function err(status: number, code: string, message: string): APIGatewayProxyResult {
  return {
    statusCode: status,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ error: { code, message } }),
  };
}

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}
