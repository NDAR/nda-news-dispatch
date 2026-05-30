import type { APIGatewayProxyHandler, APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  QueryCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  contactStatusIndexPk,
  materializeAudienceProfiles,
} from '../../../packages/shared/src';

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
      case 'GET /admin/audience/count':
        return ok(await countActiveAudience());
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

// ── GET /admin/audience/count ──────────────────────────────────────────────

/**
 * Fast count of "sendable" contacts: status = active AND not globally
 * suppressed (and, when `typeId` is supplied, not per-type-suppressed
 * for that newsletter type). Used by the TopBar's "X on the list"
 * indicator, the Send-page audience preview's `total` denominator, and
 * anywhere else we need the denominator without the full audience.
 *
 * Why this exists separately from previewAudience: previewAudience
 * materializes every matching profile into Lambda memory (to compute
 * topTags + a preview sample), then transports the full result set
 * over the wire. For a count-only consumer that's ~4 MB of wasted IO
 * at 13K contacts, 10x worse at 50K. This function instead runs a DDB
 * Query with `Select: 'COUNT'` so DynamoDB walks the index server-side
 * and returns just the integer per page — no items materialized, no
 * serialization. Pagination is still required because each Query page
 * is capped at 1 MB *scanned*, but each round-trip is tiny.
 *
 * The FilterExpression mirrors `makeSuppressionFilter(typeId)` from the
 * shared audience module: drop the `suppressedGlobal` flag, the legacy
 * `suppressed` boolean (so pre- and post-migration data count
 * identically), and when a typeId is supplied, anything carrying that
 * typeId in its `suppressedTypes` String Set.
 */
async function countActiveAudience(typeId?: string): Promise<{ count: number }> {
  // `=` and `contains()` against a missing attribute both return false
  // in DDB, so `NOT (...)` is true for "attribute missing" — exactly the
  // behavior we want for the denorm flags and the optional set field.
  const filterParts = ['(NOT suppressedGlobal = :true)', '(NOT suppressed = :true)'];
  const exprValues: Record<string, unknown> = {
    ':pk': contactStatusIndexPk('active'),
    ':true': true,
  };
  if (typeId) {
    filterParts.push('(NOT contains(suppressedTypes, :typeId))');
    exprValues[':typeId'] = typeId;
  }
  const filterExpression = filterParts.join(' AND ');

  let count = 0;
  let cursor: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName: TABLE,
        IndexName: 'GSI2',
        KeyConditionExpression: 'GSI2PK = :pk',
        FilterExpression: filterExpression,
        ExpressionAttributeValues: exprValues,
        Select: 'COUNT',
        ExclusiveStartKey: cursor,
      }),
    );
    count += res.Count ?? 0;
    cursor = res.LastEvaluatedKey;
  } while (cursor);
  return { count };
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
  /** Default `false`. When `true`, also computes the `topTags` breakdown
   *  — which requires reading every matched profile and is the slow
   *  half of the endpoint. The Send page calls without this flag first
   *  (count + sample only) and then makes a second call with the flag
   *  set to lazily backfill the breakdown. */
  topTags?: boolean;
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
 * Two-mode preview:
 *   - Default (`topTags === false` / unset): the FAST path. Computes
 *     `count`, `total`, and `sample` without materializing every
 *     matched profile. Both `count` and `sample` come from a GSI2 Query
 *     over the active-status partition with a FilterExpression
 *     expressing the chosen tags + excludeTags + suppression rules.
 *     For `count` we use `Select: 'COUNT'` (DynamoDB walks the index
 *     server-side and returns integers, no item payloads). For
 *     `sample` we paginate the same query until we collect 8 matching
 *     profiles. `topTags` returns `[]`.
 *   - `topTags === true`: the SLOW path. Same as the previous
 *     behavior: fetch every matched profile via the GSI1 tag-set →
 *     BatchGet → filter pipeline (now parallel-batched, so the
 *     materialization itself is ~10× faster than it was), then
 *     iterate to build the `topTags` histogram.
 *
 * The Send page calls the fast path first so the recipient count + the
 * 8-row preview render in ~300 ms even at 45 K matched, then calls
 * again with `topTags: true` in the background to backfill the tag
 * breakdown when it's ready.
 */
async function previewAudience(input: PreviewInput): Promise<PreviewResponse> {
  const tagMode = input.tagMode === 'any' ? 'any' : 'all';
  const tags = validTags(input.tags);
  const excludeTags = validTags(input.excludeTags);
  const typeId = typeof input.typeId === 'string' && input.typeId.trim() ? input.typeId.trim() : undefined;

  if (input.topTags === true) {
    return previewAudienceFull({ tags, excludeTags, tagMode, typeId });
  }
  return previewAudienceFast({ tags, excludeTags, tagMode, typeId });
}

/**
 * Slow path: materialize every matched profile (now with parallel
 * BatchGet under the hood) so we can iterate to build the topTags
 * histogram. Used only when the caller explicitly asks for topTags.
 */
async function previewAudienceFull(opts: {
  tags: string[];
  excludeTags: string[];
  tagMode: 'all' | 'any';
  typeId: string | undefined;
}): Promise<PreviewResponse> {
  const [matched, totalRes] = await Promise.all([
    materializeAudienceProfiles(ddb, TABLE, opts),
    countActiveAudience(opts.typeId),
  ]);
  const total = totalRes.count;

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

/**
 * Fast path: count + sample without materializing the matched set.
 *
 * Both the count and the sample come from a single GSI2 Query over the
 * `CONTACTSTATUS#active` partition with a FilterExpression that:
 *   - Drops globally-suppressed contacts (`suppressedGlobal`) and the
 *     legacy `suppressed` boolean.
 *   - When `typeId` is supplied, drops anything with that typeId in its
 *     `suppressedTypes` String Set.
 *   - Requires every tag in `tags` (tagMode='all') or any of them
 *     (tagMode='any'). DDB `contains(list, value)` works against the
 *     PROFILE.tags list.
 *   - Excludes any tag in `excludeTags` via `NOT contains(tags, :ex)`.
 *
 * The count is run with `Select: 'COUNT'` so DDB doesn't transport item
 * payloads. The sample runs the same query (without COUNT) with a small
 * page budget — we accumulate up to SAMPLE_SIZE matching profiles, then
 * stop. Pre-filter pages are 1 MB scanned; for any reasonable filter
 * cardinality we hit 8 matches in the first page or two.
 */
async function previewAudienceFast(opts: {
  tags: string[];
  excludeTags: string[];
  tagMode: 'all' | 'any';
  typeId: string | undefined;
}): Promise<PreviewResponse> {
  const filter = buildAudienceFilter(opts);

  const [matchedCount, sample, totalRes] = await Promise.all([
    countWithFilter(filter),
    sampleWithFilter(filter, SAMPLE_SIZE),
    countActiveAudience(opts.typeId),
  ]);

  return {
    count: matchedCount,
    total: totalRes.count,
    topTags: [],
    sample,
  };
}

interface AudienceFilter {
  expression: string;
  values: Record<string, unknown>;
}

function buildAudienceFilter(opts: {
  tags: string[];
  excludeTags: string[];
  tagMode: 'all' | 'any';
  typeId: string | undefined;
}): AudienceFilter {
  const parts: string[] = [
    '(NOT suppressedGlobal = :true)',
    '(NOT suppressed = :true)',
  ];
  const values: Record<string, unknown> = {
    ':pk': contactStatusIndexPk('active'),
    ':true': true,
  };
  if (opts.typeId) {
    parts.push('(NOT contains(suppressedTypes, :typeId))');
    values[':typeId'] = opts.typeId;
  }
  if (opts.tags.length > 0) {
    const tagClauses = opts.tags.map((t, i) => {
      const key = `:tagInc${i}`;
      values[key] = t;
      return `contains(tags, ${key})`;
    });
    parts.push(
      opts.tagMode === 'any'
        ? `(${tagClauses.join(' OR ')})`
        : tagClauses.map((c) => `(${c})`).join(' AND '),
    );
  }
  for (let i = 0; i < opts.excludeTags.length; i++) {
    const key = `:tagEx${i}`;
    values[key] = opts.excludeTags[i];
    parts.push(`(NOT contains(tags, ${key}))`);
  }
  return { expression: parts.join(' AND '), values };
}

async function countWithFilter(filter: AudienceFilter): Promise<number> {
  let count = 0;
  let cursor: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName: TABLE,
        IndexName: 'GSI2',
        KeyConditionExpression: 'GSI2PK = :pk',
        FilterExpression: filter.expression,
        ExpressionAttributeValues: filter.values,
        Select: 'COUNT',
        ExclusiveStartKey: cursor,
      }),
    );
    count += res.Count ?? 0;
    cursor = res.LastEvaluatedKey;
  } while (cursor);
  return count;
}

async function sampleWithFilter(
  filter: AudienceFilter,
  target: number,
): Promise<PreviewSampleContact[]> {
  const out: PreviewSampleContact[] = [];
  let cursor: Record<string, unknown> | undefined;
  // Paginate until we either fill the sample or exhaust the partition.
  // No artificial page cap: for popular filters we exit on the first
  // page (lots of matches → inner loop breaks at `target`); for rare
  // filters we must scan to the end to find the one (or few) matches,
  // same as `countWithFilter` does, so wall-clock matches its sibling.
  // Earlier versions capped pages at 5, which silently returned an
  // empty sample for low-cardinality tags whose match landed later in
  // the partition.
  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName: TABLE,
        IndexName: 'GSI2',
        KeyConditionExpression: 'GSI2PK = :pk',
        FilterExpression: filter.expression,
        ExpressionAttributeValues: filter.values,
        // Strip everything except the preview-row fields so each
        // returned profile is ~80–150 B instead of ~300–500 B. Matters
        // when matches are dense: smaller items mean more matches fit
        // into a 1 MB response page → fewer round-trips on average,
        // and less Lambda-side parsing.
        ProjectionExpression: 'email, #n, org',
        ExpressionAttributeNames: { '#n': 'name' },
        ExclusiveStartKey: cursor,
      }),
    );
    for (const item of res.Items ?? []) {
      out.push({
        email: String(item.email ?? ''),
        name: String(item.name ?? ''),
        org: typeof item.org === 'string' ? item.org : undefined,
      });
      if (out.length >= target) return out;
    }
    cursor = res.LastEvaluatedKey;
  } while (cursor);
  return out;
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
