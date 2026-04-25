import type { APIGatewayProxyHandler, APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  ScanCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const TABLE = mustEnv('TABLE_NAME');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VALID_REASONS = ['manual', 'bounce', 'complaint', 'unsubscribe'] as const;

export const handler: APIGatewayProxyHandler = async (event) => {
  try {
    const route = `${event.httpMethod} ${event.resource}`;
    switch (route) {
      case 'GET /admin/suppressions':
        return ok(await listSuppressions(event));
      case 'POST /admin/suppressions':
        return ok(await addSuppression(parseBody(event), claimsOf(event)));
      case 'DELETE /admin/suppressions/{email}':
        return ok(await removeSuppression(decodeEmail(event)));
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

interface SuppressionInput {
  email?: string;
  reason?: string;
  note?: string;
}

async function listSuppressions(event: APIGatewayProxyEvent): Promise<{ items: unknown[] }> {
  // For small suppression lists, scan with filter is fine. Revisit with a
  // dedicated GSI when the suppression table grows past ~10k items.
  const limit = clampInt(event.queryStringParameters?.limit, 1, 500, 100);
  const res = await ddb.send(
    new ScanCommand({
      TableName: TABLE,
      FilterExpression: 'begins_with(PK, :p) AND begins_with(SK, :s)',
      ExpressionAttributeValues: { ':p': 'SUPP#', ':s': 'REASON#' },
      Limit: limit,
    }),
  );
  return { items: (res.Items ?? []).map(stripKeys) };
}

async function addSuppression(
  input: SuppressionInput,
  claims: Claims,
): Promise<{ email: string; reason: string }> {
  const email = (input.email ?? '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'invalid-email', 'Invalid email');
  const reason = (input.reason ?? 'manual').trim().toLowerCase();
  if (!VALID_REASONS.includes(reason as (typeof VALID_REASONS)[number])) {
    throw new HttpError(400, 'invalid-reason', `reason must be one of: ${VALID_REASONS.join(', ')}`);
  }
  const now = new Date().toISOString();
  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        PK: `SUPP#${email}`,
        SK: `REASON#${reason}`,
        email,
        reason,
        source: 'manual',
        note: input.note,
        addedAt: now,
        addedBy: claims.email ?? claims.sub,
      },
    }),
  );
  return { email, reason };
}

async function removeSuppression(email: string): Promise<{ email: string; removed: number }> {
  const existing = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': `SUPP#${email}` },
    }),
  );
  const items = existing.Items ?? [];
  await Promise.all(
    items.map((item) =>
      ddb.send(
        new DeleteCommand({
          TableName: TABLE,
          Key: { PK: item.PK, SK: item.SK },
        }),
      ),
    ),
  );
  return { email, removed: items.length };
}

// ── Helpers ────────────────────────────────────────────────────────────────

type Claims = { sub?: string; email?: string };

function stripKeys(item: Record<string, unknown>): Record<string, unknown> {
  const { PK, SK, GSI1PK, GSI1SK, ...rest } = item as Record<string, unknown>;
  void PK; void SK; void GSI1PK; void GSI1SK;
  return rest;
}

function parseBody<T = Record<string, unknown>>(event: APIGatewayProxyEvent): T {
  if (!event.body) return {} as T;
  try {
    return JSON.parse(event.body) as T;
  } catch {
    throw new HttpError(400, 'invalid-json', 'Request body must be valid JSON');
  }
}

function decodeEmail(event: APIGatewayProxyEvent): string {
  const raw = event.pathParameters?.email;
  if (!raw) throw new HttpError(400, 'missing-path', 'email path parameter is required');
  const e = decodeURIComponent(raw).trim().toLowerCase();
  if (!EMAIL_RE.test(e)) throw new HttpError(400, 'invalid-email', 'Invalid email');
  return e;
}

function claimsOf(event: APIGatewayProxyEvent): Claims {
  const c = (event.requestContext.authorizer?.claims ?? {}) as Record<string, string>;
  return { sub: c.sub, email: c.email };
}

function clampInt(s: string | undefined, min: number, max: number, fallback: number): number {
  const n = s ? parseInt(s, 10) : NaN;
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
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
