import type { APIGatewayProxyHandler, APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  DeleteCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const s3 = new S3Client({});

const TABLE = mustEnv('TABLE_NAME');
const ARCHIVE_BUCKET = mustEnv('ARCHIVE_BUCKET');
const PUBLIC_HOST = mustEnv('PUBLIC_HOST');
const PRESIGN_TTL_SECONDS = 900;

const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

export const handler: APIGatewayProxyHandler = async (event) => {
  try {
    const route = `${event.httpMethod} ${event.resource}`;
    switch (route) {
      case 'POST /admin/assets':
        return ok(await createAsset(parseBody(event), claimsOf(event)));
      case 'GET /admin/assets':
        return ok(await listAssets());
      case 'DELETE /admin/assets/{id}':
        return ok(await deleteAsset(path(event, 'id')));
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

interface CreateAssetInput {
  filename?: string;
  contentType?: string;
  size?: number;
}

interface AssetMeta {
  id: string;
  filename: string;
  contentType: string;
  size?: number;
  key: string;
  url: string;
  createdAt: string;
  createdBy?: string;
}

async function createAsset(input: CreateAssetInput, claims: Claims): Promise<{
  id: string;
  uploadUrl: string;
  url: string;
  key: string;
  expiresIn: number;
  contentType: string;
}> {
  const filename = sanitizeFilename(input.filename ?? 'asset');
  const contentType = (input.contentType ?? '').toLowerCase();
  if (!ALLOWED_TYPES.has(contentType)) {
    throw new HttpError(415, 'unsupported-type', `Unsupported content type: ${contentType || '(empty)'}`);
  }
  if (input.size !== undefined && input.size > MAX_BYTES) {
    throw new HttpError(413, 'payload-too-large', `Asset exceeds ${MAX_BYTES / 1024 / 1024}MB limit`);
  }

  const id = randomUUID();
  // The S3 key MUST mirror the URL path exactly. CloudFront's /archive/*
  // behavior forwards the request to S3 without rewriting the path, so
  // `/archive/assets/<id>/<file>` becomes the literal S3 key
  // `archive/assets/<id>/<file>`. Storing under `assets/...` (no prefix)
  // would make the OAC-locked bucket return 403 for the lookup.
  const key = `archive/assets/${id}/${filename}`;
  const url = `https://${PUBLIC_HOST}/${key}`;
  const now = new Date().toISOString();

  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        PK: `ASSET#${id}`,
        SK: 'META',
        GSI1PK: 'ASSET#all',
        GSI1SK: now,
        id,
        filename,
        contentType,
        size: input.size,
        key,
        url,
        createdAt: now,
        createdBy: claims.email ?? claims.sub,
      },
    }),
  );

  const uploadUrl = await getSignedUrl(
    s3,
    new PutObjectCommand({
      Bucket: ARCHIVE_BUCKET,
      Key: key,
      ContentType: contentType,
      CacheControl: 'public, max-age=31536000, immutable',
    }),
    { expiresIn: PRESIGN_TTL_SECONDS },
  );

  return { id, uploadUrl, url, key, expiresIn: PRESIGN_TTL_SECONDS, contentType };
}

async function listAssets(): Promise<{ items: AssetMeta[] }> {
  const res = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk',
      ExpressionAttributeValues: { ':pk': 'ASSET#all' },
      ScanIndexForward: false,
      Limit: 200,
    }),
  );
  const items = (res.Items ?? []).map((i) => stripKeys(i)) as AssetMeta[];
  return { items };
}

async function deleteAsset(id: string): Promise<{ id: string; deleted: true }> {
  const meta = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: { PK: `ASSET#${id}`, SK: 'META' } }),
  );
  if (!meta.Item) throw new HttpError(404, 'not-found', `Asset ${id} not found`);
  const key = String(meta.Item.key);
  // Best-effort S3 delete; if the upload never completed the object may not
  // exist — DeleteObject returns 204 either way, so no special handling.
  await s3.send(new DeleteObjectCommand({ Bucket: ARCHIVE_BUCKET, Key: key }));
  await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { PK: `ASSET#${id}`, SK: 'META' } }));
  return { id, deleted: true };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function sanitizeFilename(raw: string): string {
  // Strip directory separators, normalize whitespace + control chars, keep
  // letters/numbers/dot/dash/underscore. Preserve extension. If the result
  // has no extension we fall back to a `.bin`-equivalent — but since the
  // contentType is already validated to image/*, the extension is mostly
  // cosmetic for the URL.
  const base = raw.split(/[\\/]/).pop() ?? 'asset';
  const cleaned = base
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80);
  return cleaned || 'asset';
}

function stripKeys(item: Record<string, unknown>): Record<string, unknown> {
  const { PK, SK, GSI1PK, GSI1SK, ...rest } = item as Record<string, unknown>;
  void PK; void SK; void GSI1PK; void GSI1SK;
  return rest;
}

function parseBody(event: APIGatewayProxyEvent): CreateAssetInput {
  if (!event.body) return {};
  try {
    return JSON.parse(event.body) as CreateAssetInput;
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
