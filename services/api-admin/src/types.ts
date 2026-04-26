import type { APIGatewayProxyHandler, APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

const TABLE = mustEnv('TABLE_NAME');

const TAG_RE = /^[a-z0-9-]{1,40}$/;
const NAME_MAX = 80;

export const handler: APIGatewayProxyHandler = async (event) => {
  try {
    const route = `${event.httpMethod} ${event.resource}`;
    switch (route) {
      case 'GET /admin/types':
        return ok(await listTypes(event));
      case 'POST /admin/types':
        return ok(await createType(parseBody(event), claimsOf(event)));
      case 'GET /admin/types/{id}':
        return ok(await getType(path(event, 'id')));
      case 'PUT /admin/types/{id}':
        return ok(await updateType(path(event, 'id'), parseBody(event)));
      case 'DELETE /admin/types/{id}':
        return ok(await archiveType(path(event, 'id')));
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

interface TypeInput {
  name?: string;
  description?: string;
  color?: number;
  defaultTags?: string[];
  defaultSubjectPrefix?: string;
  /** Optional HTML body that seeds new newsletters created with this type. */
  defaultBodyHtml?: string;
}

interface TypeRecord {
  id: string;
  name: string;
  description?: string;
  color: number;
  defaultTags: string[];
  defaultSubjectPrefix?: string;
  defaultBodyHtml?: string;
  archived?: boolean;
  createdAt: string;
  createdBy?: string;
}

const BODY_HTML_MAX = 200_000;

async function listTypes(event: APIGatewayProxyEvent): Promise<TypeRecord[]> {
  const includeArchived = event.queryStringParameters?.includeArchived === '1';
  const res = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk',
      ExpressionAttributeValues: { ':pk': 'TYPE#latest' },
    }),
  );
  return (res.Items ?? [])
    .map((item) => stripKeys(item) as TypeRecord)
    .filter((t) => includeArchived || !t.archived)
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function getType(id: string): Promise<TypeRecord> {
  const res = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: { PK: `TYPE#${id}`, SK: 'LATEST' } }),
  );
  if (!res.Item) throw new HttpError(404, 'not-found', `Type ${id} not found`);
  return stripKeys(res.Item) as TypeRecord;
}

async function createType(body: TypeInput, claims: Claims): Promise<TypeRecord> {
  const record = normalizeInput(randomUUID(), body, claims, new Date().toISOString());

  // Sentinel row for case-insensitive name uniqueness. Written conditionally;
  // if a type with the same name already exists, the create is rejected.
  const sentinelKey = { PK: `TYPENAME#${record.name.toLowerCase()}`, SK: 'CLAIM' };
  try {
    await ddb.send(
      new PutCommand({
        TableName: TABLE,
        Item: { ...sentinelKey, typeId: record.id },
        ConditionExpression: 'attribute_not_exists(PK)',
      }),
    );
  } catch (e) {
    const code = (e as { name?: string }).name;
    if (code === 'ConditionalCheckFailedException') {
      throw new HttpError(409, 'name-taken', `A type named "${record.name}" already exists`);
    }
    throw e;
  }

  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        PK: `TYPE#${record.id}`,
        SK: 'LATEST',
        GSI1PK: 'TYPE#latest',
        GSI1SK: record.id,
        ...record,
      },
    }),
  );
  return record;
}

async function updateType(id: string, body: TypeInput): Promise<TypeRecord> {
  const existing = await getType(id);
  const merged: TypeRecord = {
    ...existing,
    name: body.name !== undefined ? cleanName(body.name) : existing.name,
    description:
      body.description !== undefined ? body.description.trim() : existing.description,
    color: body.color !== undefined ? validateHue(body.color) : existing.color,
    defaultTags:
      body.defaultTags !== undefined ? validateTags(body.defaultTags) : existing.defaultTags,
    defaultSubjectPrefix:
      body.defaultSubjectPrefix !== undefined
        ? body.defaultSubjectPrefix
        : existing.defaultSubjectPrefix,
    defaultBodyHtml:
      body.defaultBodyHtml !== undefined
        ? validateBodyHtml(body.defaultBodyHtml)
        : existing.defaultBodyHtml,
  };

  // Sentinel rotation when renaming.
  if (merged.name.toLowerCase() !== existing.name.toLowerCase()) {
    try {
      await ddb.send(
        new PutCommand({
          TableName: TABLE,
          Item: {
            PK: `TYPENAME#${merged.name.toLowerCase()}`,
            SK: 'CLAIM',
            typeId: id,
          },
          ConditionExpression: 'attribute_not_exists(PK)',
        }),
      );
    } catch (e) {
      const code = (e as { name?: string }).name;
      if (code === 'ConditionalCheckFailedException') {
        throw new HttpError(409, 'name-taken', `A type named "${merged.name}" already exists`);
      }
      throw e;
    }
    await ddb.send(
      new DeleteCommand({
        TableName: TABLE,
        Key: { PK: `TYPENAME#${existing.name.toLowerCase()}`, SK: 'CLAIM' },
      }),
    );
  }

  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        PK: `TYPE#${id}`,
        SK: 'LATEST',
        GSI1PK: 'TYPE#latest',
        GSI1SK: id,
        ...merged,
      },
    }),
  );
  return merged;
}

async function archiveType(id: string): Promise<{ id: string; archived: true }> {
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { PK: `TYPE#${id}`, SK: 'LATEST' },
      UpdateExpression: 'SET archived = :a',
      ConditionExpression: 'attribute_exists(PK)',
      ExpressionAttributeValues: { ':a': true },
    }),
  );
  return { id, archived: true };
}

function normalizeInput(
  id: string,
  body: TypeInput,
  claims: Claims,
  createdAt: string,
): TypeRecord {
  return {
    id,
    name: cleanName(body.name ?? ''),
    description: body.description?.trim() || undefined,
    color: validateHue(body.color ?? 200),
    defaultTags: validateTags(body.defaultTags ?? []),
    defaultSubjectPrefix: body.defaultSubjectPrefix?.trim() || undefined,
    defaultBodyHtml: validateBodyHtml(body.defaultBodyHtml),
    createdAt,
    createdBy: claims.email ?? claims.sub,
  };
}

function validateBodyHtml(html: string | undefined): string | undefined {
  if (html === undefined) return undefined;
  const trimmed = html.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > BODY_HTML_MAX) {
    throw new HttpError(400, 'invalid-input', `defaultBodyHtml must be ≤ ${BODY_HTML_MAX} chars`);
  }
  return trimmed;
}

function cleanName(raw: string): string {
  const name = raw.trim();
  if (!name) throw new HttpError(400, 'invalid-input', 'name is required');
  if (name.length > NAME_MAX) {
    throw new HttpError(400, 'invalid-input', `name must be ≤ ${NAME_MAX} chars`);
  }
  return name;
}

function validateHue(n: unknown): number {
  const v = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(v) || v < 0 || v > 360) {
    throw new HttpError(400, 'invalid-input', 'color must be a hue 0..360');
  }
  return Math.round(v);
}

function validateTags(v: string[]): string[] {
  const out = [...new Set(v.map((t) => t.trim().toLowerCase()))].filter(Boolean);
  for (const t of out) {
    if (!TAG_RE.test(t)) throw new HttpError(400, 'invalid-tag', `Invalid tag: ${t}`);
  }
  return out;
}

function stripKeys(item: Record<string, unknown>): Record<string, unknown> {
  const { PK, SK, GSI1PK, GSI1SK, ...rest } = item as Record<string, unknown>;
  void PK; void SK; void GSI1PK; void GSI1SK;
  return rest;
}

function parseBody(event: APIGatewayProxyEvent): TypeInput {
  if (!event.body) return {};
  try {
    return JSON.parse(event.body) as TypeInput;
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
