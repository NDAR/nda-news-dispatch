import type { APIGatewayProxyHandler, APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  DynamoDBDocumentClient,
  QueryCommand,
  ScanCommand,
  PutCommand,
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
}

async function listContacts(event: APIGatewayProxyEvent): Promise<{ items: Contact[]; next?: string }> {
  const qs = event.queryStringParameters ?? {};
  const limit = clampInt(qs.limit, 1, 200, 50);
  const next = qs.next;
  const status = qs.status;
  if (status && status !== 'active' && status !== 'unsubscribed' && status !== 'bounced') {
    throw new HttpError(400, 'invalid-status', `Unknown status: ${status}`);
  }

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
    const filtered = status ? profiles.filter((p) => p.status === status) : profiles;
    return { items: filtered, next: idx.LastEvaluatedKey ? encodeCursor(idx.LastEvaluatedKey) : undefined };
  }

  // Status filter is applied via FilterExpression so we don't pull every
  // profile into memory just to throw most away. Note: DDB applies Limit
  // BEFORE FilterExpression, so a page with mostly active contacts may yield
  // fewer than `limit` matches when filtering for unsubscribed/bounced — the
  // pagination cursor still advances correctly.
  const expr: string[] = ['SK = :sk', 'begins_with(PK, :p)'];
  const values: Record<string, unknown> = { ':sk': 'PROFILE', ':p': 'CONTACT#' };
  const names: Record<string, string> = {};
  if (status) {
    expr.push('#s = :status');
    values[':status'] = status;
    names['#s'] = 'status';
  }
  const scan = await ddb.send(
    new ScanCommand({
      TableName: TABLE,
      FilterExpression: expr.join(' AND '),
      ExpressionAttributeValues: values,
      ExpressionAttributeNames: Object.keys(names).length ? names : undefined,
      Limit: limit,
      ExclusiveStartKey: next ? decodeCursor(next) : undefined,
    }),
  );
  return {
    items: (scan.Items ?? []).map(toContact),
    next: scan.LastEvaluatedKey ? encodeCursor(scan.LastEvaluatedKey) : undefined,
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

  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
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
        suppressedAt: existing.Item?.suppressedAt,
        suppressionReason: existing.Item?.suppressionReason,
        ...contactStatusIndexFields(c.email, c.status),
      },
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
  return {
    email: String(item.email),
    name: String(item.name ?? ''),
    org: (item.org as string | undefined) ?? undefined,
    tags: (item.tags as string[] | undefined) ?? [],
    status: (item.status as Contact['status'] | undefined) ?? 'active',
    joined: String(item.joined ?? ''),
    updatedAt: String(item.updatedAt ?? ''),
  };
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
