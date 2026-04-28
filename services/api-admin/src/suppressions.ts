import type { APIGatewayProxyHandler, APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  applySuppression,
  contactStatusIndexFields,
  parseSuppressionSk,
  removeAllSuppressions,
  removeSuppression as removeOneSuppression,
  VALID_SUPPRESSION_REASONS,
  type SuppressionReason,
  type SuppressionScope,
} from '../../../packages/shared/src';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const TABLE = mustEnv('TABLE_NAME');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TYPE_NAME_TTL_MS = 60_000;
const typeNameCache = new Map<string, { at: number; name?: string }>();

export const handler: APIGatewayProxyHandler = async (event) => {
  try {
    const route = `${event.httpMethod} ${event.resource}`;
    switch (route) {
      case 'GET /admin/suppressions':
        return ok(await listSuppressions(event));
      case 'POST /admin/suppressions':
        return ok(await addSuppression(parseBody(event), claimsOf(event)));
      case 'DELETE /admin/suppressions/{email}':
        return ok(await deleteSuppression(event));
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
  scope?: string;
  typeId?: string;
  reason?: string;
  note?: string;
}

interface SuppressionListItem {
  email: string;
  /** Echo the actual SK so the DELETE can target this exact row. Without
   *  it, legacy `REASON#…` rows are visible in the list (they map to
   *  scope=global) but the canonical-SK delete (`TYPE#GLOBAL`) silently
   *  no-ops on them, leaving the row visible after "Remove". */
  sk: string;
  scope: SuppressionScope;
  typeId?: string;
  typeName?: string;
  reason: string;
  source?: string;
  campaignId?: string;
  messageId?: string;
  note?: string;
  addedBy?: string;
  addedAt: string;
}

async function listSuppressions(event: APIGatewayProxyEvent): Promise<{ items: SuppressionListItem[] }> {
  // Single-table layout: SUPP#<email> rows have SK starting with TYPE#. We
  // also include legacy REASON#-prefixed rows so the operator can see (and
  // delete) them during the migration window.
  //
  // We paginate the Scan because DynamoDB applies `Limit` BEFORE the
  // FilterExpression — without pagination a table with lots of non-SUPP
  // rows (campaign RCPT rows etc.) silently returns zero matches even when
  // SUPP rows exist. Cap total raw rows scanned at PAGE_CAP per request to
  // keep one Lambda invocation predictable; admins can re-call to keep
  // walking via cursor if it's ever exceeded (we don't yet expose one,
  // because suppression lists are small in practice).
  const limit = clampInt(event.queryStringParameters?.limit, 1, 500, 100);
  const scope = parseScopeQuery(event.queryStringParameters?.scope);
  const typeIdFilter = event.queryStringParameters?.typeId;
  const PAGE_SIZE = 1000;
  const PAGE_CAP = 50_000;

  const items: SuppressionListItem[] = [];
  let scanned = 0;
  let cursor: Record<string, unknown> | undefined;

  while (items.length < limit && scanned < PAGE_CAP) {
    const res = await ddb.send(
      new ScanCommand({
        TableName: TABLE,
        FilterExpression: 'begins_with(PK, :p) AND (begins_with(SK, :tsk) OR begins_with(SK, :rsk))',
        ExpressionAttributeValues: { ':p': 'SUPP#', ':tsk': 'TYPE#', ':rsk': 'REASON#' },
        Limit: PAGE_SIZE,
        ExclusiveStartKey: cursor,
      }),
    );
    scanned += res.ScannedCount ?? 0;
    for (const raw of res.Items ?? []) {
      const item = await mapSuppressionItem(raw as Record<string, unknown>);
      if (!item) continue;
      if (scope && item.scope !== scope) continue;
      if (typeIdFilter && item.typeId !== typeIdFilter) continue;
      items.push(item);
      if (items.length >= limit) break;
    }
    cursor = res.LastEvaluatedKey;
    if (!cursor) break;
  }

  return { items };
}

async function addSuppression(
  input: SuppressionInput,
  claims: Claims,
): Promise<{ email: string; scope: SuppressionScope; typeId?: string; reason: string }> {
  const email = (input.email ?? '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'invalid-email', 'Invalid email');
  const reason = ((input.reason ?? 'manual').trim().toLowerCase()) as SuppressionReason;
  if (!(VALID_SUPPRESSION_REASONS as readonly string[]).includes(reason)) {
    throw new HttpError(
      400,
      'invalid-reason',
      `reason must be one of: ${VALID_SUPPRESSION_REASONS.join(', ')}`,
    );
  }
  const scope = parseScopeBody(input.scope);
  const typeId = scope === 'type' ? cleanTypeId(input.typeId) : undefined;
  if (scope === 'type' && !typeId) {
    throw new HttpError(400, 'missing-type-id', 'typeId is required when scope is "type"');
  }
  if (typeId) await assertTypeExists(typeId);

  await applySuppression(ddb, TABLE, {
    email,
    scope,
    typeId,
    reason,
    source: 'manual',
    note: input.note,
    addedBy: claims.email ?? claims.sub,
  });
  return { email, scope, typeId, reason };
}

async function deleteSuppression(event: APIGatewayProxyEvent): Promise<{ email: string; removed: number }> {
  const email = decodeEmail(event);
  const qs = event.queryStringParameters ?? {};
  const scopeRaw = (qs.scope ?? '').toLowerCase();
  const skRaw = qs.sk ? String(qs.sk) : '';

  // Targeted exact-SK delete. Used by the SPA — the row carries its own
  // SK via the list endpoint, so a legacy `REASON#bounce` row is deleted
  // by its real SK rather than by the canonical scope SK (which would
  // no-op for legacy rows and leave them in the list).
  if (skRaw && (skRaw.startsWith('TYPE#') || skRaw.startsWith('REASON#'))) {
    await ddb.send(
      new DeleteCommand({
        TableName: TABLE,
        Key: { PK: `SUPP#${email}`, SK: skRaw },
      }),
    );
    // Re-derive the contact denorm hints from whatever rows remain.
    await refreshContactAfterDelete(email);
    return { email, removed: 1 };
  }

  if (scopeRaw === 'all') {
    const removed = await removeAllSuppressions(ddb, TABLE, email);
    return { email, removed };
  }
  if (scopeRaw === 'global' || scopeRaw === 'type') {
    const typeId = scopeRaw === 'type' ? cleanTypeId(qs.typeId) : undefined;
    if (scopeRaw === 'type' && !typeId) {
      throw new HttpError(400, 'missing-type-id', 'typeId query param is required when scope=type');
    }
    await removeOneSuppression(ddb, TABLE, {
      email,
      scope: scopeRaw,
      typeId,
    });
    return { email, removed: 1 };
  }
  // Default: remove every SUPP row for the email. Preserves the legacy
  // behavior of `DELETE /admin/suppressions/{email}` and is the path the
  // SPA uses for "Remove" on the Global tab when they want a clean slate.
  const removed = await removeAllSuppressions(ddb, TABLE, email);
  return { email, removed };
}

/**
 * Mirror of removeSuppression's denorm refresh, but invoked after we've
 * already deleted by exact SK. Walks the remaining SUPP#<email> rows and
 * rewrites suppressedGlobal / suppressedTypes / the legacy `suppressed`
 * boolean accordingly. Idempotent.
 */
async function refreshContactAfterDelete(email: string): Promise<void> {
  // We re-implement the small read+write here rather than re-export
  // private helpers from the shared module — keeps the shared API tight.
  const remaining = await ddb.send(
    new ScanCommand({
      TableName: TABLE,
      FilterExpression: 'PK = :pk AND (begins_with(SK, :tsk) OR begins_with(SK, :rsk))',
      ExpressionAttributeValues: {
        ':pk': `SUPP#${email}`,
        ':tsk': 'TYPE#',
        ':rsk': 'REASON#',
      },
    }),
  );
  let hasGlobal = false;
  const types: string[] = [];
  for (const row of remaining.Items ?? []) {
    const sk = String(row.SK ?? '');
    const parsed = parseSuppressionSk(sk);
    if (!parsed) continue;
    if (parsed.scope === 'global') hasGlobal = true;
    if (parsed.scope === 'type' && parsed.typeId) types.push(parsed.typeId);
  }

  const stillSuppressed = hasGlobal || types.length > 0;
  const at = new Date().toISOString();

  if (!stillSuppressed) {
    // Also restore the contact's status / GSI2 partition if it was flipped
    // to `unsubscribed` or `bounced` when the suppression was first applied.
    // Without this, the subscribers list keeps showing the contact as
    // "unsubscribed" after the SUPP row is gone.
    const profile = await ddb.send(
      new GetCommand({
        TableName: TABLE,
        Key: { PK: `CONTACT#${email}`, SK: 'PROFILE' },
        ProjectionExpression: '#s',
        ExpressionAttributeNames: { '#s': 'status' },
      }),
    ).catch(() => null);
    const currentStatus = profile?.Item?.status;
    const restoreActive = currentStatus === 'unsubscribed' || currentStatus === 'bounced';
    const sets = ['suppressedGlobal = :false', 'suppressed = :false', 'updatedAt = :u'];
    const removes = ['suppressedTypes', 'suppressedAt', 'suppressionReason'];
    const values: Record<string, unknown> = { ':false': false, ':u': at };
    const names: Record<string, string> = {};
    if (restoreActive) {
      const idx = contactStatusIndexFields(email, 'active');
      sets.push('#s = :active', 'GSI2PK = :gsi2pk', 'GSI2SK = :gsi2sk');
      removes.push('unsubscribedAt', 'bouncedAt');
      names['#s'] = 'status';
      values[':active'] = 'active';
      values[':gsi2pk'] = idx.GSI2PK;
      values[':gsi2sk'] = idx.GSI2SK;
    }
    const expr = 'SET ' + sets.join(', ') + ' REMOVE ' + removes.join(', ');
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { PK: `CONTACT#${email}`, SK: 'PROFILE' },
        UpdateExpression: expr,
        ConditionExpression: 'attribute_exists(PK)',
        ExpressionAttributeNames: Object.keys(names).length > 0 ? names : undefined,
        ExpressionAttributeValues: values,
      }),
    ).catch(() => undefined);
    return;
  }

  const sets: string[] = ['suppressedGlobal = :g', 'suppressed = :true', 'updatedAt = :u'];
  const removes: string[] = [];
  const values: Record<string, unknown> = {
    ':g': hasGlobal,
    ':true': true,
    ':u': at,
  };
  if (types.length > 0) {
    sets.push('suppressedTypes = :tset');
    values[':tset'] = new Set(types);
  } else {
    removes.push('suppressedTypes');
  }
  const expr = 'SET ' + sets.join(', ') + (removes.length > 0 ? ' REMOVE ' + removes.join(', ') : '');
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { PK: `CONTACT#${email}`, SK: 'PROFILE' },
      UpdateExpression: expr,
      ConditionExpression: 'attribute_exists(PK)',
      ExpressionAttributeValues: values,
    }),
  ).catch(() => undefined);
}

async function mapSuppressionItem(item: Record<string, unknown>): Promise<SuppressionListItem | null> {
  const email = String(item.email ?? '');
  const sk = String(item.SK ?? '');
  const parsed = parseSuppressionSk(sk);
  if (!email || !parsed) return null;
  const typeName = parsed.scope === 'type' && parsed.typeId
    ? await loadTypeName(parsed.typeId)
    : undefined;
  return {
    email,
    sk,
    scope: parsed.scope,
    typeId: parsed.typeId,
    typeName,
    reason: typeof item.reason === 'string' ? item.reason : 'manual',
    source: typeof item.source === 'string' ? item.source : undefined,
    campaignId: typeof item.campaignId === 'string' ? item.campaignId : undefined,
    messageId: typeof item.messageId === 'string' ? item.messageId : undefined,
    note: typeof item.note === 'string' ? item.note : undefined,
    addedBy: typeof item.addedBy === 'string' ? item.addedBy : undefined,
    addedAt: typeof item.addedAt === 'string' ? item.addedAt : '',
  };
}

async function loadTypeName(typeId: string): Promise<string | undefined> {
  const now = Date.now();
  const cached = typeNameCache.get(typeId);
  if (cached && now - cached.at < TYPE_NAME_TTL_MS) return cached.name;
  const res = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: { PK: `TYPE#${typeId}`, SK: 'LATEST' } }),
  );
  const name = typeof res.Item?.name === 'string' ? res.Item.name : undefined;
  typeNameCache.set(typeId, { at: now, name });
  return name;
}

async function assertTypeExists(typeId: string): Promise<void> {
  const name = await loadTypeName(typeId);
  if (name === undefined) {
    throw new HttpError(404, 'type-not-found', `Newsletter type ${typeId} not found`);
  }
}

function parseScopeQuery(raw: string | undefined): SuppressionScope | null {
  if (!raw) return null;
  const v = raw.toLowerCase();
  if (v === 'global' || v === 'type') return v;
  return null;
}

function parseScopeBody(raw: string | undefined): SuppressionScope {
  const v = (raw ?? 'global').toLowerCase();
  if (v === 'global' || v === 'type') return v;
  throw new HttpError(400, 'invalid-scope', 'scope must be "global" or "type"');
}

function cleanTypeId(raw: string | undefined): string | undefined {
  const v = (raw ?? '').trim();
  return v ? v : undefined;
}

// ── Helpers ────────────────────────────────────────────────────────────────

type Claims = { sub?: string; email?: string };

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
