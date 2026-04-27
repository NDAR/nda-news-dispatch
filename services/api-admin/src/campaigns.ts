import type { APIGatewayProxyHandler, APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import {
  SchedulerClient,
  CreateScheduleCommand,
  DeleteScheduleCommand,
  FlexibleTimeWindowMode,
} from '@aws-sdk/client-scheduler';
import {
  batchGetAll,
  batchWriteAll,
  materializeAudienceEmails,
} from '../../../packages/shared/src';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const sqs = new SQSClient({});
const scheduler = new SchedulerClient({});

const TABLE = mustEnv('TABLE_NAME');
const ENQUEUE_QUEUE_URL = mustEnv('ENQUEUE_QUEUE_URL');
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
      case 'GET /admin/campaigns/{id}/recipients':
        return ok(await listCampaignRecipients(path(event, 'id')));
      case 'GET /admin/campaigns/{id}/links':
        return ok(await listCampaignLinks(path(event, 'id')));
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
  /** Denormalized from the template at create time. Persists even if the
   *  type is later renamed or archived so historical analytics stay stable. */
  typeId?: string;
  subject: string;
  html: string;
  status: 'draft' | 'scheduled' | 'queueing' | 'queued' | 'sending' | 'sent' | 'failed';
  recipients: number;
  tags: string[];
  excludeTags: string[];
  tagMode: 'all' | 'any';
  createdAt: string;
  createdBy?: string;
  sentAt?: string;
  scheduleAt?: string;
}

async function listCampaigns(
  event: APIGatewayProxyEvent,
): Promise<{ items: (CampaignRecord & { stats?: Record<string, number> })[] }> {
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
  const items = (res.Items ?? []).map(stripKeys) as CampaignRecord[];
  const stats = await batchGetStats(items.map((c) => c.id));
  return {
    items: items.map((c) => ({ ...c, stats: stats.get(c.id) })),
  };
}

async function batchGetStats(ids: string[]): Promise<Map<string, Record<string, number>>> {
  const out = new Map<string, Record<string, number>>();
  if (ids.length === 0) return out;
  const items = await batchGetAll<Record<string, unknown>>(
    ddb,
    TABLE,
    ids.map((campaignId) => ({ PK: `CAMPAIGN#${campaignId}`, SK: 'STATS' })),
  );
  for (const item of items) {
    const id = String(item.PK).replace(/^CAMPAIGN#/, '');
    out.set(id, stripKeys(item) as Record<string, number>);
  }
  return out;
}

interface CampaignRecipient {
  email: string;
  state?: string;
  queuedAt?: string;
  deliveredAt?: string;
  openedAt?: string;
  clickedAt?: string;
  lastClickUrl?: string;
  bouncedAt?: string;
  bounceType?: string;
  complainedAt?: string;
  rejectedAt?: string;
  failedAt?: string;
  lastDelayAt?: string;
  messageId?: string;
}

const RECIPIENTS_CAP = 5000;

/**
 * Returns the per-recipient engagement rows for a campaign in a single
 * response. Capped at RECIPIENTS_CAP to keep the call bounded; flag the
 * truncation so the UI can warn. Used by the detail page to render the
 * opens timeline, top-links table, and the CSV export — no other call site
 * fans out per-recipient queries today.
 */
async function listCampaignRecipients(
  id: string,
): Promise<{ items: CampaignRecipient[]; truncated: boolean }> {
  const items: CampaignRecipient[] = [];
  let cursor: Record<string, unknown> | undefined;
  let truncated = false;
  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: {
          ':pk': `CAMPAIGN#${id}`,
          ':sk': 'RCPT#',
        },
        ExclusiveStartKey: cursor,
      }),
    );
    for (const it of res.Items ?? []) {
      items.push(stripKeys(it) as unknown as CampaignRecipient);
      if (items.length >= RECIPIENTS_CAP) {
        truncated = true;
        break;
      }
    }
    cursor = truncated ? undefined : res.LastEvaluatedKey;
  } while (cursor);
  return { items, truncated };
}

/**
 * Per-URL click stats for a campaign. Backed by `LINK#{hash}` rows written
 * by worker-events; unique vs. total clicks per link.
 */
interface CampaignLink {
  url: string;
  clicks: number;
  uniqueClicks: number;
  firstSeenAt?: string;
  lastSeenAt?: string;
}

async function listCampaignLinks(id: string): Promise<{ items: CampaignLink[] }> {
  const items: CampaignLink[] = [];
  let cursor: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: { ':pk': `CAMPAIGN#${id}`, ':sk': 'LINK#' },
        ExclusiveStartKey: cursor,
      }),
    );
    for (const it of res.Items ?? []) {
      items.push({
        url: typeof it.url === 'string' ? it.url : '',
        clicks: typeof it.clicks === 'number' ? it.clicks : 0,
        uniqueClicks: typeof it.uniqueClicks === 'number' ? it.uniqueClicks : 0,
        firstSeenAt: typeof it.firstSeenAt === 'string' ? it.firstSeenAt : undefined,
        lastSeenAt: typeof it.lastSeenAt === 'string' ? it.lastSeenAt : undefined,
      });
    }
    cursor = res.LastEvaluatedKey;
  } while (cursor);
  items.sort((a, b) => b.clicks - a.clicks || b.uniqueClicks - a.uniqueClicks);
  return { items };
}

async function getCampaign(id: string): Promise<CampaignRecord & { stats: Record<string, number> }> {
  const [meta, stats] = await Promise.all([
    ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: `CAMPAIGN#${id}`, SK: 'META' } })),
    ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: `CAMPAIGN#${id}`, SK: 'STATS' } })),
  ]);
  if (!meta.Item) throw new HttpError(404, 'not-found', `Campaign ${id} not found`);
  return {
    ...(stripKeys(meta.Item) as unknown as CampaignRecord),
    stats: (stats.Item ? stripKeys(stats.Item) : {}) as Record<string, number>,
  };
}

async function createCampaign(input: CampaignInput, claims: Claims): Promise<CampaignRecord> {
  const id = randomUUID();
  const now = new Date().toISOString();
  let subject = (input.subject ?? '').trim();
  let html = input.html ?? '';
  let templateVersion: number | undefined;
  let typeId: string | undefined;

  if (input.templateId) {
    const t = await ddb.send(
      new GetCommand({ TableName: TABLE, Key: { PK: `TEMPLATE#${input.templateId}`, SK: 'LATEST' } }),
    );
    if (!t.Item) throw new HttpError(404, 'template-not-found', `Template ${input.templateId} not found`);
    subject = subject || String(t.Item.subject ?? '');
    html = html || String(t.Item.html ?? '');
    templateVersion = t.Item.version as number;
    typeId = t.Item.typeId as string | undefined;
  }

  if (!subject) throw new HttpError(400, 'invalid-input', 'subject is required');
  if (!html) throw new HttpError(400, 'invalid-input', 'html is required');

  const record: CampaignRecord = {
    id,
    name: (input.name ?? '').trim() || 'Untitled campaign',
    templateId: input.templateId,
    templateVersion,
    typeId,
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
  await batchWriteAll(ddb, TABLE, [
    { DeleteRequest: { Key: { PK: `CAMPAIGN#${id}`, SK: 'META' } } },
    { DeleteRequest: { Key: { PK: `CAMPAIGN#${id}`, SK: 'STATS' } } },
  ]);
  return { id, deleted: true };
}

async function sendCampaign(
  id: string,
  input: SendInput,
  claims: Claims,
): Promise<{ id: string; status: string; enqueued: number; scheduleAt?: string }> {
  const meta = await ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: `CAMPAIGN#${id}`, SK: 'META' } }));
  if (!meta.Item) throw new HttpError(404, 'not-found', `Campaign ${id} not found`);

  const tagMode = input.tagMode === 'any' ? 'any' : 'all';
  const tags = validTags(input.tags);
  const excludeTags = validTags(input.excludeTags);
  const testOnly = !!input.testOnly;
  const actor = claims.email ?? claims.sub ?? 'unknown';

  const typeId = typeof meta.Item.typeId === 'string' ? meta.Item.typeId : undefined;
  if (testOnly) {
    await materializeAudienceEmails(ddb, TABLE, { tagMode, tags, excludeTags, typeId });
    return { id, status: 'draft', enqueued: 0 };
  }

  if (input.scheduleAt) {
    const scheduleAt = validateScheduleAt(input.scheduleAt);
    if (!SCHEDULE_GROUP || !SCHEDULE_EXEC_ROLE_ARN || !DISPATCH_FN_ARN) {
      throw new HttpError(503, 'scheduler-unconfigured', 'Scheduled sends are not enabled in this environment');
    }

    await claimStatusFromDraft(id, 'scheduled', {
      tags,
      excludeTags,
      tagMode,
      actor,
      scheduleAt,
    });

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
      await rollbackScheduledDraft(id).catch(() => undefined);
      throw e;
    }

    return { id, status: 'scheduled', enqueued: 0, scheduleAt };
  }

  const now = new Date().toISOString();
  // Hand off to the worker-enqueue Lambda (via SQS) so the API call returns
  // promptly even for 50K-recipient campaigns. The worker materializes the
  // audience, writes RCPT rows, and pushes per-recipient messages into the
  // send queue. Status flow: draft → queueing → queued → (sending) → ...
  await claimStatusFromDraft(id, 'queueing', { tags, excludeTags, tagMode, actor });

  try {
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: ENQUEUE_QUEUE_URL,
        MessageBody: JSON.stringify({ campaignId: id }),
      }),
    );
    return { id, status: 'queueing', enqueued: 0 };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await markStatus(id, 'failed', { sentAt: now, error: msg });
    throw e;
  }
}

/**
 * Cancels a scheduled campaign by deleting its EventBridge schedule and
 * reverting the META row to 'draft'. No-op if the campaign isn't scheduled.
 */
async function cancelScheduledCampaign(id: string): Promise<{ id: string; status: 'draft' }> {
  const meta = await ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: `CAMPAIGN#${id}`, SK: 'META' } }));
  if (!meta.Item) throw new HttpError(404, 'not-found', `Campaign ${id} not found`);
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { PK: `CAMPAIGN#${id}`, SK: 'META' },
        UpdateExpression: 'SET #s = :s, GSI1PK = :gpk REMOVE scheduleAt, scheduledBy',
        ConditionExpression: '#s = :scheduled',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: {
          ':s': 'draft',
          ':gpk': 'STATUS#draft',
          ':scheduled': 'scheduled',
        },
      }),
    );
  } catch (e) {
    if (isConditionalFailure(e)) {
      throw new HttpError(409, 'illegal-state', 'Campaign is no longer scheduled');
    }
    throw e;
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

function stripKeys(item: Record<string, unknown>): Record<string, unknown> {
  const { PK, SK, GSI1PK, GSI1SK, ...rest } = item as Record<string, unknown>;
  void PK; void SK; void GSI1PK; void GSI1SK;
  return rest;
}

async function claimStatusFromDraft(
  id: string,
  nextStatus: 'scheduled' | 'queueing',
  opts: {
    tags: string[];
    excludeTags: string[];
    tagMode: 'all' | 'any';
    actor: string;
    scheduleAt?: string;
  },
): Promise<void> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { PK: `CAMPAIGN#${id}`, SK: 'META' },
        UpdateExpression:
          'SET #s = :s, tags = :t, excludeTags = :x, tagMode = :m, GSI1PK = :gpk, sentBy = :sb' +
          (opts.scheduleAt ? ', scheduleAt = :sched, scheduledBy = :sb' : ' REMOVE scheduleAt, scheduledBy'),
        ConditionExpression: '#s = :draft',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: {
          ':s': nextStatus,
          ':draft': 'draft',
          ':t': opts.tags,
          ':x': opts.excludeTags,
          ':m': opts.tagMode,
          ':gpk': `STATUS#${nextStatus}`,
          ':sb': opts.actor,
          ':sched': opts.scheduleAt,
        },
      }),
    );
  } catch (e) {
    if (isConditionalFailure(e)) {
      throw new HttpError(409, 'illegal-state', 'Campaign is no longer a draft');
    }
    throw e;
  }
}

async function rollbackScheduledDraft(id: string): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { PK: `CAMPAIGN#${id}`, SK: 'META' },
      UpdateExpression: 'SET #s = :s, GSI1PK = :gpk REMOVE scheduleAt, scheduledBy',
      ConditionExpression: '#s = :scheduled',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: {
        ':s': 'draft',
        ':gpk': 'STATUS#draft',
        ':scheduled': 'scheduled',
      },
    }),
  );
}

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

function isConditionalFailure(err: unknown): boolean {
  return (err as { name?: string }).name === 'ConditionalCheckFailedException';
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
