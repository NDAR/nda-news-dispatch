import type { APIGatewayProxyHandler, APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  BatchWriteCommand,
  DynamoDBDocumentClient,
  QueryCommand,
  ScanCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  batchGetAll,
  batchWriteAll,
  contactStatusIndexFields,
} from '../../../packages/shared/src';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const TABLE = mustEnv('TABLE_NAME');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TAG_RE = /^[a-z0-9-]{1,40}$/;

export const handler: APIGatewayProxyHandler = async (event) => {
  try {
    const route = `${event.httpMethod} ${event.resource}`;
    switch (route) {
      case 'GET /admin/contacts':
        return ok(await listContacts(event));
      case 'POST /admin/contacts':
        return ok(await upsertContact(parseBody(event)));
      case 'POST /admin/contacts/delete-all':
        return ok(await deleteAllContacts(parseDeleteAllBody(event), claimsOf(event)));
      case 'GET /admin/contacts/{email}':
        return ok(await getContact(decodeEmail(event)));
      case 'PATCH /admin/contacts/{email}':
        return ok(await patchContact(decodeEmail(event), parseBody(event)));
      case 'DELETE /admin/contacts/{email}':
        return ok(await deleteContact(decodeEmail(event)));
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

// ── Contact operations ─────────────────────────────────────────────────────

interface ContactInput {
  email?: string;
  name?: string;
  org?: string;
  tags?: string[];
  status?: 'active' | 'unsubscribed' | 'bounced';
}

interface Contact {
  email: string;
  name: string;
  org?: string;
  tags: string[];
  status: 'active' | 'unsubscribed' | 'bounced';
  joined: string;
  updatedAt: string;
  /** Derived: true if any suppression (global or per-type) is in effect. */
  suppressed?: boolean;
  /** Hard suppression — blocks every send regardless of type. */
  suppressedGlobal?: boolean;
  /** Per-type suppressions (newsletter typeIds the contact has opted out of). */
  suppressedTypes?: string[];
}

// Hard cap on DDB pages a single listContacts request will scan while
// accumulating matches. Each Scan page is up to 1MB (~5K small profile rows),
// so 20 pages = ~100K rows scanned ≈ a few seconds. This bounds the worst-case
// latency when a narrow search filter has very few hits in a large table.
const LIST_MAX_SCAN_PAGES = 20;

async function listContacts(event: APIGatewayProxyEvent): Promise<{ items: Contact[]; next?: string }> {
  const qs = event.queryStringParameters ?? {};
  const limit = clampInt(qs.limit, 1, 200, 50);
  const next = qs.next;
  const status = qs.status;
  if (status && status !== 'active' && status !== 'unsubscribed' && status !== 'bounced') {
    throw new HttpError(400, 'invalid-status', `Unknown status: ${status}`);
  }
  // Email substring search. Emails are stored lowercased by both the importer
  // and upsertContact, so a case-insensitive contains() reduces to a plain
  // contains() against a lowercased needle.
  const searchRaw = (qs.q ?? '').trim().toLowerCase();
  const search = searchRaw.length > 0 ? searchRaw.slice(0, 100) : '';

  if (qs.tag) {
    if (!TAG_RE.test(qs.tag)) throw new HttpError(400, 'invalid-tag', 'Invalid tag');
    const idx = await ddb.send(
      new QueryCommand({
        TableName: TABLE,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :pk',
        ExpressionAttributeValues: { ':pk': `TAG#${qs.tag}` },
        Limit: limit,
        ExclusiveStartKey: next ? decodeCursor(next) : undefined,
      }),
    );
    // Tag rows project `email` directly (see writeContact); GSI1SK is the
    // composite `CONTACT#<email>`. Using GSI1SK here would double-prefix the
    // PK in batchGetProfiles and produce zero matches.
    const emails = (idx.Items ?? []).map((i: Record<string, unknown>) => String(i.email));
    const profiles = await batchGetProfiles(emails);
    let filtered = status ? profiles.filter((p) => p.status === status) : profiles;
    if (search) filtered = filtered.filter((p) => p.email.includes(search));
    return { items: filtered, next: idx.LastEvaluatedKey ? encodeCursor(idx.LastEvaluatedKey) : undefined };
  }

  // Build FilterExpression. DDB applies Limit BEFORE FilterExpression, so a
  // single Scan page can yield fewer than `limit` matches when a filter is
  // present. We loop across pages until we either fill the requested page or
  // run out of items / hit LIST_MAX_SCAN_PAGES.
  const expr: string[] = ['SK = :sk', 'begins_with(PK, :p)'];
  const values: Record<string, unknown> = { ':sk': 'PROFILE', ':p': 'CONTACT#' };
  const names: Record<string, string> = {};
  if (status) {
    expr.push('#s = :status');
    values[':status'] = status;
    names['#s'] = 'status';
  }
  if (search) {
    expr.push('contains(email, :q)');
    values[':q'] = search;
  }

  const items: Contact[] = [];
  let cursor: Record<string, unknown> | undefined = next ? decodeCursor(next) : undefined;
  let pages = 0;
  // Loop because the base predicate (SK = PROFILE AND begins_with(PK,
  // CONTACT#)) is itself a FilterExpression — a single Scan page can return
  // few or zero matching profiles even with no user filters. We let DDB
  // return its full 1MB chunk per page and stop accumulating when we hit the
  // requested limit.
  while (items.length < limit && pages < LIST_MAX_SCAN_PAGES) {
    const scan = await ddb.send(
      new ScanCommand({
        TableName: TABLE,
        FilterExpression: expr.join(' AND '),
        ExpressionAttributeValues: values,
        ExpressionAttributeNames: Object.keys(names).length ? names : undefined,
        ExclusiveStartKey: cursor,
      }),
    );
    pages++;
    for (const it of scan.Items ?? []) {
      items.push(toContact(it as Record<string, unknown>));
      if (items.length >= limit) break;
    }
    cursor = scan.LastEvaluatedKey;
    if (!cursor) break;
  }
  // If we filled the page mid-scan, the cursor must resume from after the
  // last item we *returned*, not from where DDB's scan page ended (which is
  // past unreturned items still in that page). Using the last returned
  // item's (PK, SK) as ExclusiveStartKey resumes from the correct spot.
  let nextCursor: Record<string, unknown> | undefined = cursor;
  if (items.length >= limit && cursor) {
    const last = items[items.length - 1];
    nextCursor = { PK: `CONTACT#${last.email}`, SK: 'PROFILE' };
  }
  return {
    items,
    next: nextCursor ? encodeCursor(nextCursor) : undefined,
  };
}

async function getContact(email: string): Promise<Contact> {
  const res = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: { PK: `CONTACT#${email}`, SK: 'PROFILE' } }),
  );
  if (!res.Item) throw new HttpError(404, 'not-found', `Contact ${email} not found`);
  return toContact(res.Item);
}

async function upsertContact(input: ContactInput): Promise<Contact> {
  const email = validEmail(input.email);
  const tags = validTags(input.tags);
  const now = new Date().toISOString();
  const existing = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: { PK: `CONTACT#${email}`, SK: 'PROFILE' } }),
  );
  const record: Contact = {
    email,
    name: input.name?.trim() || existing.Item?.name || email.split('@')[0],
    org: input.org?.trim() ?? (existing.Item?.org as string | undefined),
    tags,
    status: input.status ?? (existing.Item?.status as Contact['status'] | undefined) ?? 'active',
    joined: (existing.Item?.joined as string | undefined) ?? now.slice(0, 10),
    updatedAt: now,
  };
  await writeContact(record, (existing.Item?.tags as string[] | undefined) ?? []);
  return record;
}

async function patchContact(email: string, input: ContactInput): Promise<Contact> {
  const existing = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: { PK: `CONTACT#${email}`, SK: 'PROFILE' } }),
  );
  if (!existing.Item) throw new HttpError(404, 'not-found', `Contact ${email} not found`);
  const prevTags = (existing.Item.tags as string[] | undefined) ?? [];
  const tags = input.tags !== undefined ? validTags(input.tags) : prevTags;
  const updated: Contact = {
    ...toContact(existing.Item),
    name: input.name?.trim() ?? existing.Item.name,
    org: input.org?.trim() ?? (existing.Item.org as string | undefined),
    tags,
    status: input.status ?? (existing.Item.status as Contact['status']),
    updatedAt: new Date().toISOString(),
  };
  await writeContact(updated, prevTags);
  return updated;
}

// Wall-clock budget for a single delete-all invocation. API Gateway REST
// caps the integration response at 29 s and the Lambda timeout is 28 s,
// so we stop work well before that to leave time for response
// serialization + connection teardown. The remaining work resumes on the
// next call — a fresh scan picks up whatever's left because the rows we
// already deleted no longer match the filter.
const DELETE_ALL_DEADLINE_MS = 20_000;
// Keep at least this much headroom when checking the deadline before
// starting a parallel write group — empirically a group of 8 BatchWrites
// completes in well under a second, but DDB throttling could stretch it.
const DELETE_ALL_TAIL_MARGIN_MS = 2_000;
// Number of BatchWriteItem requests we issue in parallel per group. Each
// request handles up to 25 deletes, so 8 in parallel = 200 deletes per
// round-trip. Higher concurrency risks DDB partition-level throttling on
// the burst; lower wastes the budget.
const DELETE_ALL_CONCURRENCY = 8;

async function deleteAllContacts(
  body: { operationId?: string },
  claims: { sub?: string; email?: string },
): Promise<{ deleted: number; done: boolean; operationId: string }> {
  // Audit: every "Delete all" click is one operation. The client generates
  // the UUID up-front and sends it on every iteration so we accumulate
  // progress on a single OP row instead of fragmenting the record across
  // server-issued IDs. If the client somehow forgets to send one, we
  // synthesize one — the audit row still gets written, the client just
  // won't be able to correlate progress across retries.
  const operationId = body.operationId ?? randomUUID();
  await ensureDeleteAllOperationRecord(operationId, claims);

  const result = await runDeleteAll();
  // Best-effort audit update — the OP row tracks cumulative deleted +
  // status. If this fails the actual deletion still happened, so we
  // don't surface the error to the caller, but we do log it.
  try {
    await updateDeleteAllOperationRecord(operationId, result.deleted, result.done);
  } catch (e) {
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'delete-all-op-update-failed',
        operationId,
        err: e instanceof Error ? e.message : String(e),
      }),
    );
  }
  return { ...result, operationId };
}

async function runDeleteAll(): Promise<{ deleted: number; done: boolean }> {
  const startMs = Date.now();
  const remaining = () => DELETE_ALL_DEADLINE_MS - (Date.now() - startMs);
  let deleted = 0;
  let cursor: Record<string, unknown> | undefined;

  // Restrict the wipe to status=active by querying GSI2 instead of
  // scanning the base table. That:
  //   1. Preserves unsubscribed / bounced contact rows so the system
  //      still "remembers" they existed and won't re-add them on a
  //      future import (their global-suppression flag on the PROFILE
  //      blocks re-import via the worker).
  //   2. Avoids reading SUPP#, IMPORT#, CAMPAIGN#, RCPT# items at all
  //      — the query targets only the `CONTACTSTATUS#active` partition
  //      of GSI2, which only indexes contact PROFILEs.
  //   3. Sidesteps the cost of scanning the whole table just to find
  //      the contact subset.
  //
  // Tag-association rows (`CONTACT#<email>/TAG#<tag>`) are NOT indexed
  // in GSI2, so we read each profile's `tags` array (projected ALL on
  // GSI2) and synthesize the tag SKs to delete alongside the profile.
  while (true) {
    if (remaining() < DELETE_ALL_TAIL_MARGIN_MS) {
      return { deleted, done: false };
    }
    const query = await ddb.send(
      new QueryCommand({
        TableName: TABLE,
        IndexName: 'GSI2',
        KeyConditionExpression: 'GSI2PK = :pk',
        ExpressionAttributeValues: { ':pk': 'CONTACTSTATUS#active' },
        ProjectionExpression: 'PK, #t',
        ExpressionAttributeNames: { '#t': 'tags' },
        ExclusiveStartKey: cursor,
      }),
    );
    const items = (query.Items ?? []) as Array<{ PK: string; tags?: string[] }>;

    // Build the delete keys for this page. Tag rows go BEFORE the
    // PROFILE for the same contact so if we bail partway through, the
    // PROFILE row (and therefore the GSI2 entry) still exists and the
    // next call's query rediscovers the contact. Tag-row deletes are
    // idempotent so retrying any we already issued is harmless.
    const keys: Array<{ PK: string; SK: string }> = [];
    for (const item of items) {
      for (const tag of item.tags ?? []) {
        keys.push({ PK: item.PK, SK: `TAG#${tag}` });
      }
      keys.push({ PK: item.PK, SK: 'PROFILE' });
    }

    const chunks: { PK: string; SK: string }[][] = [];
    for (let i = 0; i < keys.length; i += 25) {
      chunks.push(keys.slice(i, i + 25));
    }
    for (let i = 0; i < chunks.length; i += DELETE_ALL_CONCURRENCY) {
      if (remaining() < DELETE_ALL_TAIL_MARGIN_MS) {
        return { deleted, done: false };
      }
      const wave = chunks.slice(i, i + DELETE_ALL_CONCURRENCY);
      await Promise.all(wave.map(deleteOneBatch));
      // Count only PROFILE rows so the running total reflects deleted
      // subscribers, not total DDB rows touched (each subscriber
      // generates 1 PROFILE + len(tags) tag-association deletes).
      deleted += wave.flat().filter((k) => k.SK === 'PROFILE').length;
    }

    cursor = query.LastEvaluatedKey;
    if (!cursor) return { deleted, done: true };
  }
}

/**
 * Issues one BatchWriteItem of up to 25 deletes, retrying any
 * UnprocessedItems with exponential backoff. Returns the count of items
 * successfully deleted by this call. We inline the logic instead of
 * reusing `batchWriteAll` so each parallel worker can independently
 * resolve its own UnprocessedItems without contending on a shared loop.
 */
async function deleteOneBatch(items: { PK: string; SK: string }[]): Promise<number> {
  if (items.length === 0) return 0;
  const requested = items.length;
  let pending: { DeleteRequest: { Key: { PK: string; SK: string } } }[] = items.map((it) => ({
    DeleteRequest: { Key: { PK: it.PK, SK: it.SK } },
  }));
  for (let attempt = 0; attempt <= 5; attempt++) {
    const res = await ddb.send(
      new BatchWriteCommand({ RequestItems: { [TABLE]: pending } }),
    );
    pending = (res.UnprocessedItems?.[TABLE] ?? []) as typeof pending;
    if (pending.length === 0) return requested;
    if (attempt === 5) {
      throw new Error(`BatchWrite exhausted retries with ${pending.length} unprocessed deletes`);
    }
    await new Promise((r) => setTimeout(r, Math.min(1000, 50 * (2 ** attempt))));
  }
  return requested;
}

/**
 * Idempotent first-touch of the audit row for a delete-all operation.
 *
 * The OP row lives in the same partition the import-history view reads
 * (GSI1PK = 'IMPORT#all') so imports and delete-ops show up together,
 * sorted by GSI1SK (timestamp). The `type` field discriminates so the
 * UI can render each kind differently.
 *
 * Uses a conditional Put with `attribute_not_exists(PK)` so concurrent
 * first-call retries from the client don't clobber an in-progress row's
 * counts back to zero. The ConditionalCheckFailed case is the expected
 * "row already created by an earlier call" path — swallowed silently.
 */
async function ensureDeleteAllOperationRecord(
  operationId: string,
  claims: { sub?: string; email?: string },
): Promise<void> {
  const now = new Date().toISOString();
  try {
    await ddb.send(
      new PutCommand({
        TableName: TABLE,
        Item: {
          PK: `OP#${operationId}`,
          SK: 'META',
          GSI1PK: 'IMPORT#all',
          GSI1SK: now,
          operationId,
          type: 'delete-all',
          status: 'processing',
          deleted: 0,
          createdAt: now,
          updatedAt: now,
          createdBy: claims.email ?? claims.sub,
        },
        ConditionExpression: 'attribute_not_exists(PK)',
      }),
    );
  } catch (e) {
    // Row already exists — every call after the first hits this. Don't
    // re-raise anything that isn't ConditionalCheckFailed.
    const name = (e as { name?: string } | undefined)?.name;
    if (name !== 'ConditionalCheckFailedException') throw e;
  }
}

/**
 * Increments the OP row's `deleted` counter by this call's delta and
 * flips status to `done` when the operation completes. Uses an UPDATE
 * (not PUT) so we can't accidentally clobber concurrent progress writes
 * — `if_not_exists(deleted, :zero) + :delta` is a safe atomic add even
 * if multiple client retries land in unexpected order.
 */
async function updateDeleteAllOperationRecord(
  operationId: string,
  delta: number,
  done: boolean,
): Promise<void> {
  const now = new Date().toISOString();
  const sets = [
    'deleted = if_not_exists(deleted, :zero) + :delta',
    'updatedAt = :now',
  ];
  const values: Record<string, unknown> = { ':zero': 0, ':delta': delta, ':now': now };
  const names: Record<string, string> = {};
  if (done) {
    sets.push('#s = :done', 'completedAt = :now');
    values[':done'] = 'done';
    names['#s'] = 'status';
  }
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { PK: `OP#${operationId}`, SK: 'META' },
      UpdateExpression: 'SET ' + sets.join(', '),
      ExpressionAttributeValues: values,
      ExpressionAttributeNames: Object.keys(names).length ? names : undefined,
    }),
  );
}

function parseDeleteAllBody(event: APIGatewayProxyEvent): { operationId?: string } {
  if (!event.body) return {};
  try {
    const body = JSON.parse(event.body) as { operationId?: unknown };
    const raw = body.operationId;
    // Validate UUID-shape so a bad client can't poison our PK space with
    // weird characters. Accept the v4-ish hex-with-dashes form only.
    if (typeof raw === 'string' && /^[0-9a-fA-F-]{36}$/.test(raw)) {
      return { operationId: raw };
    }
    return {};
  } catch {
    return {};
  }
}

function claimsOf(event: APIGatewayProxyEvent): { sub?: string; email?: string } {
  const c = (event.requestContext.authorizer?.claims ?? {}) as Record<string, string>;
  return { sub: c.sub, email: c.email };
}

async function deleteContact(email: string): Promise<{ email: string; deleted: true }> {
  const existing = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: { PK: `CONTACT#${email}`, SK: 'PROFILE' } }),
  );
  const prevTags = (existing.Item?.tags as string[] | undefined) ?? [];
  const requests = [
    { DeleteRequest: { Key: { PK: `CONTACT#${email}`, SK: 'PROFILE' } } },
    ...prevTags.map((t) => ({ DeleteRequest: { Key: { PK: `CONTACT#${email}`, SK: `TAG#${t}` } } })),
  ];
  await batchWriteAll(ddb, TABLE, requests);
  return { email, deleted: true };
}

async function writeContact(c: Contact, prevTags: string[]): Promise<void> {
  const toRemove = prevTags.filter((t) => !c.tags.includes(t));
  const toAdd = c.tags.filter((t) => !prevTags.includes(t));
  const existing = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: { PK: `CONTACT#${c.email}`, SK: 'PROFILE' } }),
  );

  // Preserve every suppression-related attribute across the Put. PutCommand
  // wholesale-replaces the item, so anything we don't include is lost.
  const preservedTypeSet = readStringSet(existing.Item?.suppressedTypes);
  const item: Record<string, unknown> = {
    PK: `CONTACT#${c.email}`,
    SK: 'PROFILE',
    email: c.email,
    name: c.name,
    org: c.org,
    tags: c.tags,
    status: c.status,
    joined: c.joined,
    updatedAt: c.updatedAt,
    suppressed: existing.Item?.suppressed === true,
    suppressedGlobal: existing.Item?.suppressedGlobal === true,
    suppressedAt: existing.Item?.suppressedAt,
    suppressionReason: existing.Item?.suppressionReason,
    ...contactStatusIndexFields(c.email, c.status),
  };
  if (preservedTypeSet.length > 0) item.suppressedTypes = new Set(preservedTypeSet);
  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: item,
    }),
  );

  const tagRequests = [
    ...toRemove.map((t) => ({ DeleteRequest: { Key: { PK: `CONTACT#${c.email}`, SK: `TAG#${t}` } } })),
    ...toAdd.map((t) => ({
      PutRequest: {
        Item: {
          PK: `CONTACT#${c.email}`,
          SK: `TAG#${t}`,
          GSI1PK: `TAG#${t}`,
          GSI1SK: `CONTACT#${c.email}`,
          email: c.email,
        },
      },
    })),
  ];
  await batchWriteAll(ddb, TABLE, tagRequests);
}

async function batchGetProfiles(emails: string[]): Promise<Contact[]> {
  if (emails.length === 0) return [];
  const items = await batchGetAll<Record<string, unknown>>(
    ddb,
    TABLE,
    emails.map((e) => ({ PK: `CONTACT#${e}`, SK: 'PROFILE' })),
  );
  return items.map((item) => toContact(item));
}

// ── Helpers ────────────────────────────────────────────────────────────────

function toContact(item: Record<string, unknown>): Contact {
  const suppressedTypes = readStringSet(item.suppressedTypes);
  const suppressedGlobal = item.suppressedGlobal === true;
  const legacySuppressed = item.suppressed === true;
  const suppressed = suppressedGlobal || suppressedTypes.length > 0 || legacySuppressed;
  return {
    email: String(item.email),
    name: String(item.name ?? ''),
    org: (item.org as string | undefined) ?? undefined,
    tags: (item.tags as string[] | undefined) ?? [],
    status: (item.status as Contact['status'] | undefined) ?? 'active',
    joined: String(item.joined ?? ''),
    updatedAt: String(item.updatedAt ?? ''),
    suppressed,
    suppressedGlobal: suppressedGlobal || (legacySuppressed && suppressedTypes.length === 0),
    suppressedTypes: suppressedTypes.length > 0 ? suppressedTypes : undefined,
  };
}

function readStringSet(value: unknown): string[] {
  if (!value) return [];
  if (value instanceof Set) {
    return [...value].filter((v): v is string => typeof v === 'string');
  }
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === 'string');
  }
  if (typeof value === 'object' && value !== null && Array.isArray((value as { values?: unknown[] }).values)) {
    return ((value as { values: unknown[] }).values).filter((v): v is string => typeof v === 'string');
  }
  return [];
}

function parseBody(event: APIGatewayProxyEvent): ContactInput {
  if (!event.body) return {};
  try {
    return JSON.parse(event.body) as ContactInput;
  } catch {
    throw new HttpError(400, 'invalid-json', 'Request body must be valid JSON');
  }
}

function decodeEmail(event: APIGatewayProxyEvent): string {
  const raw = event.pathParameters?.email;
  if (!raw) throw new HttpError(400, 'missing-path', 'email path parameter is required');
  return validEmail(decodeURIComponent(raw));
}

function validEmail(v: string | undefined): string {
  const e = (v ?? '').trim().toLowerCase();
  if (!EMAIL_RE.test(e)) throw new HttpError(400, 'invalid-email', 'Invalid email');
  return e;
}

function validTags(v: string[] | undefined): string[] {
  if (!v) return [];
  const out = [...new Set(v.map((t) => t.trim().toLowerCase()))];
  for (const t of out) {
    if (!TAG_RE.test(t)) throw new HttpError(400, 'invalid-tag', `Invalid tag: ${t}`);
  }
  return out;
}

function clampInt(s: string | undefined, min: number, max: number, fallback: number): number {
  const n = s ? parseInt(s, 10) : NaN;
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function encodeCursor(key: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(key)).toString('base64url');
}

function decodeCursor(s: string): Record<string, unknown> {
  try {
    return JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid-cursor', 'Invalid pagination cursor');
  }
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
