import type { APIGatewayProxyHandler, APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import { materializeAudienceProfiles } from '../../../packages/shared/src';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const TABLE = mustEnv('TABLE_NAME');

const TAG_RE = /^[a-z0-9-]{1,40}$/;
const SAMPLE_SIZE = 8;
const TOP_TAGS = 5;

export const handler: APIGatewayProxyHandler = async (event) => {
  try {
    const route = `${event.httpMethod} ${event.resource}`;
    switch (route) {
      case 'GET /admin/tags':
        return ok(await listAllTags());
      case 'POST /admin/audience/preview':
        return ok(await previewAudience(parseBody(event)));
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

// ── GET /admin/tags ────────────────────────────────────────────────────────

interface TagsResponse {
  items: { tag: string; count: number }[];
}

/**
 * Enumerates every distinct tag in use by scanning the (CONTACT#…, TAG#…)
 * relationship rows. Cheap relative to the contact table because each tag-row
 * holds only the join key. Fine for up to a few thousand contacts; switch to
 * a TAG#all aggregate item if the table grows much beyond that.
 */
async function listAllTags(): Promise<TagsResponse> {
  const counts = new Map<string, number>();
  let cursor: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(
      new ScanCommand({
        TableName: TABLE,
        FilterExpression: 'begins_with(PK, :p) AND begins_with(SK, :s)',
        ExpressionAttributeValues: { ':p': 'CONTACT#', ':s': 'TAG#' },
        ProjectionExpression: 'SK',
        ExclusiveStartKey: cursor,
      }),
    );
    for (const item of res.Items ?? []) {
      const sk = String(item.SK ?? '');
      if (!sk.startsWith('TAG#')) continue;
      const tag = sk.slice('TAG#'.length);
      if (!tag) continue;
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    cursor = res.LastEvaluatedKey;
  } while (cursor);

  const items = [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => (b.count - a.count) || a.tag.localeCompare(b.tag));
  return { items };
}

// ── POST /admin/audience/preview ───────────────────────────────────────────

interface PreviewInput {
  tags?: string[];
  excludeTags?: string[];
  tagMode?: 'all' | 'any';
  /** When provided, the preview drops recipients with a per-type
   *  unsubscribe for this typeId so the count matches what the matching
   *  campaign would actually send. */
  typeId?: string;
}

interface PreviewSampleContact {
  email: string;
  name: string;
  org?: string;
}

interface PreviewResponse {
  /** Number of active, non-suppressed contacts that match the filter. */
  count: number;
  /** Total active, non-suppressed contacts in the system (the denominator). */
  total: number;
  /** Top tags among matched recipients, sorted by count desc. */
  topTags: { tag: string; count: number }[];
  /** First few matched contacts for the UI preview row. */
  sample: PreviewSampleContact[];
}

/**
 * Mirrors the materialization logic in campaigns.ts/sendCampaign so the
 * Send-page preview reflects exactly who would receive the campaign — but
 * without writing RCPT items or queueing SQS messages. Fetches contact
 * profiles for the matched candidates so we can compute the tag breakdown
 * and the sample row at the same time.
 */
async function previewAudience(input: PreviewInput): Promise<PreviewResponse> {
  const tagMode = input.tagMode === 'any' ? 'any' : 'all';
  const tags = validTags(input.tags);
  const excludeTags = validTags(input.excludeTags);
  const typeId = typeof input.typeId === 'string' && input.typeId.trim() ? input.typeId.trim() : undefined;

  const [matched, allActive] = await Promise.all([
    materializeAudienceProfiles(ddb, TABLE, { tags, excludeTags, tagMode, typeId }),
    materializeAudienceProfiles(ddb, TABLE, { tags: [], excludeTags: [], tagMode: 'all', typeId }),
  ]);
  const total = allActive.length;

  const tagCounts: Record<string, number> = {};
  for (const m of matched) for (const t of m.tags) tagCounts[t] = (tagCounts[t] ?? 0) + 1;
  const topTags = Object.entries(tagCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_TAGS)
    .map(([tag, count]) => ({ tag, count }));

  const sample = matched.slice(0, SAMPLE_SIZE).map((m) => ({
    email: m.email,
    name: m.name,
    org: m.org,
  }));

  return { count: matched.length, total, topTags, sample };
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
