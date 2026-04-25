import type { APIGatewayProxyHandler, APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const s3 = new S3Client({});
const TABLE = mustEnv('TABLE_NAME');
const IMPORTS_BUCKET = mustEnv('IMPORTS_BUCKET');
const PRESIGN_TTL_SECONDS = 900;

const TAG_RE = /^[a-z0-9-]{1,40}$/;

export const handler: APIGatewayProxyHandler = async (event) => {
  try {
    const route = `${event.httpMethod} ${event.resource}`;
    switch (route) {
      case 'POST /admin/imports':
        return ok(await createImport(parseBody(event), claimsOf(event)));
      case 'GET /admin/imports':
        return ok(await listImports());
      case 'GET /admin/imports/{id}':
        return ok(await getImport(path(event, 'id')));
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

interface CreateImportInput {
  filename?: string;
  assignTags?: string[];
  /** @deprecated kept for backward compatibility with older clients */
  assignTag?: string;
}

async function createImport(input: CreateImportInput, claims: Claims): Promise<{
  importId: string;
  uploadUrl: string;
  key: string;
  expiresIn: number;
}> {
  // Accept either `assignTags: string[]` (current) or `assignTag: string`
  // (legacy single-tag form). Combine, normalize, validate.
  const raw = [
    ...(input.assignTags ?? []),
    ...(input.assignTag ? [input.assignTag] : []),
  ];
  const assignTags = [...new Set(raw.map((t) => t.trim().toLowerCase()).filter(Boolean))];
  for (const t of assignTags) {
    if (!TAG_RE.test(t)) throw new HttpError(400, 'invalid-tag', `Invalid tag: ${t}`);
  }
  const importId = randomUUID();
  const key = `imports/${importId}.csv`;
  const now = new Date().toISOString();

  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        PK: `IMPORT#${importId}`,
        SK: 'META',
        GSI1PK: 'IMPORT#all',
        GSI1SK: now,
        importId,
        key,
        filename: input.filename,
        assignTags,
        status: 'pending',
        counts: { total: 0, inserted: 0, updated: 0, suppressed: 0, invalid: 0 },
        createdAt: now,
        createdBy: claims.email ?? claims.sub,
      },
    }),
  );

  const uploadUrl = await getSignedUrl(
    s3,
    new PutObjectCommand({
      Bucket: IMPORTS_BUCKET,
      Key: key,
      ContentType: 'text/csv',
    }),
    { expiresIn: PRESIGN_TTL_SECONDS },
  );

  return { importId, uploadUrl, key, expiresIn: PRESIGN_TTL_SECONDS };
}

async function listImports(): Promise<{ items: unknown[] }> {
  const res = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk',
      ExpressionAttributeValues: { ':pk': 'IMPORT#all' },
      ScanIndexForward: false,
      Limit: 50,
    }),
  );
  return { items: (res.Items ?? []).map(stripKeys) };
}

async function getImport(id: string): Promise<unknown> {
  const res = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: { PK: `IMPORT#${id}`, SK: 'META' } }),
  );
  if (!res.Item) throw new HttpError(404, 'not-found', `Import ${id} not found`);
  return stripKeys(res.Item);
}

// ── Helpers ────────────────────────────────────────────────────────────────

type Claims = { sub?: string; email?: string };

function stripKeys(item: Record<string, unknown>): Record<string, unknown> {
  const { PK, SK, GSI1PK, GSI1SK, ...rest } = item as Record<string, unknown>;
  void PK; void SK; void GSI1PK; void GSI1SK;
  return rest;
}

function parseBody(event: APIGatewayProxyEvent): CreateImportInput {
  if (!event.body) return {};
  try {
    return JSON.parse(event.body) as CreateImportInput;
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
