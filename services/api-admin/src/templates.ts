import type { APIGatewayProxyHandler, APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { randomUUID } from 'node:crypto';
import {
  DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const s3 = new S3Client({});

const TABLE = mustEnv('TABLE_NAME');
const ARCHIVE_BUCKET = mustEnv('ARCHIVE_BUCKET');

export const handler: APIGatewayProxyHandler = async (event) => {
  try {
    const route = `${event.httpMethod} ${event.resource}`;
    switch (route) {
      case 'GET /admin/templates':
        return ok(await listTemplates());
      case 'POST /admin/templates':
        return ok(await createTemplate(parseBody(event), claimsOf(event)));
      case 'GET /admin/templates/{id}':
        return ok(await getTemplate(path(event, 'id')));
      case 'PUT /admin/templates/{id}':
        return ok(await putTemplateVersion(path(event, 'id'), parseBody(event), claimsOf(event)));
      case 'DELETE /admin/templates/{id}':
        return ok(await softDeleteTemplate(path(event, 'id')));
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

// ── Template operations ────────────────────────────────────────────────────

interface TemplateInput {
  title?: string;
  subject?: string;
  html?: string;
  targetTags?: string[];
}

interface TemplateRecord {
  id: string;
  version: number;
  title: string;
  subject: string;
  html: string;
  targetTags: string[];
  updatedAt: string;
  updatedBy?: string;
  deleted?: boolean;
}

async function listTemplates(): Promise<TemplateRecord[]> {
  const res = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk',
      ExpressionAttributeValues: { ':pk': 'TEMPLATE#latest' },
    }),
  );
  return (res.Items ?? [])
    .filter((i) => !i.deleted)
    .map((item) => withIdFromPk(stripKeys(item), item.PK)) as TemplateRecord[];
}

async function getTemplate(id: string): Promise<TemplateRecord> {
  const latest = await ddb.send(
    new GetCommand({
      TableName: TABLE,
      Key: { PK: `TEMPLATE#${id}`, SK: 'LATEST' },
    }),
  );
  if (!latest.Item || latest.Item.deleted) throw new HttpError(404, 'not-found', `Template ${id} not found`);
  const rec = withIdFromPk(stripKeys(latest.Item), latest.Item.PK);
  if (!rec.id) rec.id = id;
  return rec as TemplateRecord;
}

/** Some earlier records were written without a separate `id` attribute —
 *  derive it from the `PK` key (`TEMPLATE#<uuid>` → `<uuid>`) so the client
 *  always has a stable identifier. */
function withIdFromPk(rest: Record<string, unknown>, pk: unknown): Record<string, unknown> {
  if (!rest.id && typeof pk === 'string' && pk.startsWith('TEMPLATE#')) {
    rest.id = pk.slice('TEMPLATE#'.length);
  }
  return rest;
}

async function createTemplate(body: TemplateInput, claims: Claims): Promise<TemplateRecord> {
  const id = randomUUID();
  const record = normalizeInput(id, 1, body, claims);
  await writeVersion(record);
  return record;
}

async function putTemplateVersion(id: string, body: TemplateInput, claims: Claims): Promise<TemplateRecord> {
  console.log(JSON.stringify({
    level: 'info', msg: 'put-template-received',
    id,
    htmlLen: body.html?.length ?? 0,
    subjectLen: body.subject?.length ?? 0,
    titleLen: body.title?.length ?? 0,
  }));
  const existing = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: { PK: `TEMPLATE#${id}`, SK: 'LATEST' } }),
  );
  const nextVersion = ((existing.Item?.version as number | undefined) ?? 0) + 1;
  const record = normalizeInput(id, nextVersion, body, claims);
  await writeVersion(record);
  console.log(JSON.stringify({
    level: 'info', msg: 'put-template-written',
    id, version: record.version, htmlLen: record.html.length,
  }));
  return record;
}

async function softDeleteTemplate(id: string): Promise<{ id: string; deleted: true }> {
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { PK: `TEMPLATE#${id}`, SK: 'LATEST' },
      UpdateExpression: 'SET deleted = :t, updatedAt = :n',
      ExpressionAttributeValues: { ':t': true, ':n': new Date().toISOString() },
      ConditionExpression: 'attribute_exists(PK)',
    }),
  );
  return { id, deleted: true };
}

async function writeVersion(r: TemplateRecord): Promise<void> {
  if (!r.id) throw new HttpError(500, 'no-id', 'writeVersion called without id');
  const base = {
    id: r.id,
    version: r.version,
    title: r.title,
    subject: r.subject,
    html: r.html,
    targetTags: r.targetTags,
    updatedAt: r.updatedAt,
    updatedBy: r.updatedBy,
  };
  await Promise.all([
    ddb.send(
      new PutCommand({
        TableName: TABLE,
        Item: { PK: `TEMPLATE#${r.id}`, SK: `v${String(r.version).padStart(6, '0')}`, ...base },
      }),
    ),
    ddb.send(
      new PutCommand({
        TableName: TABLE,
        Item: {
          PK: `TEMPLATE#${r.id}`,
          SK: 'LATEST',
          GSI1PK: 'TEMPLATE#latest',
          GSI1SK: r.id,
          ...base,
        },
      }),
    ),
    s3.send(
      new PutObjectCommand({
        Bucket: ARCHIVE_BUCKET,
        Key: `renders/${r.id}/v${r.version}.html`,
        Body: r.html,
        ContentType: 'text/html; charset=utf-8',
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    ),
  ]);
}

// ── Helpers ────────────────────────────────────────────────────────────────

type Claims = { sub?: string; email?: string };

function normalizeInput(id: string, version: number, body: TemplateInput, claims: Claims): TemplateRecord {
  const title = (body.title ?? '').trim();
  const subject = (body.subject ?? '').trim();
  const html = body.html ?? '';
  if (!title) throw new HttpError(400, 'invalid-input', 'title is required');
  if (html.length > 500_000) throw new HttpError(413, 'payload-too-large', 'html exceeds 500KB');
  const tags = Array.isArray(body.targetTags) ? body.targetTags.filter((t) => /^[a-z0-9-]{1,40}$/.test(t)) : [];
  return {
    id,
    version,
    title,
    subject,
    html,
    targetTags: tags,
    updatedAt: new Date().toISOString(),
    updatedBy: claims.email ?? claims.sub,
  };
}

function stripKeys(item: Record<string, unknown>): Record<string, unknown> {
  const { PK, SK, GSI1PK, GSI1SK, ...rest } = item as Record<string, unknown>;
  void PK; void SK; void GSI1PK; void GSI1SK;
  return rest;
}

function parseBody(event: APIGatewayProxyEvent): TemplateInput {
  if (!event.body) return {};
  try {
    return JSON.parse(event.body) as TemplateInput;
  } catch {
    throw new HttpError(400, 'invalid-json', 'Request body must be valid JSON');
  }
}

function path(event: APIGatewayProxyEvent, key: string): string {
  const v = event.pathParameters?.[key];
  if (!v) throw new HttpError(400, 'missing-path', `Path parameter "${key}" required`);
  return v;
}

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
