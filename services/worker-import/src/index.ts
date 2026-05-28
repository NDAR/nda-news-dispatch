import type { SQSHandler, SQSRecord, S3Event, S3EventRecord } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { batchGetAll, batchWriteAll, contactStatusIndexFields } from '../../../packages/shared/src';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const s3 = new S3Client({});
const TABLE = mustEnv('TABLE_NAME');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Rows-per-chunk for bulk processing. 100 is DynamoDB's BatchGetItem maximum
// — anything larger would have to be split internally anyway. Each chunk
// issues ~2 BatchGet round-trips + a handful of BatchWrites, so for a 50K
// CSV we converge on a few hundred round-trips total instead of the 100K+
// the previous per-row code generated.
const IMPORT_CHUNK_SIZE = 100;
// Cap on how many per-row failure records we attach to the IMPORT META
// item. 2000 entries × ~80 bytes leaves comfortable headroom under DDB's
// 400KB item limit alongside the existing fields. When exceeded we set
// `failuresTruncated: true` so the UI can call it out; the aggregate
// `counts.{invalid,suppressed}` totals stay accurate either way.
const MAX_FAILURES = 2000;
// Raw `email` field values from invalid rows can be anything (garbage,
// long strings). Truncate before persisting so a pathological CSV can't
// blow the DDB item limit single-handedly.
const MAX_FAILURE_EMAIL_LENGTH = 200;

/**
 * SQS trigger — receives S3 PutObject events for the imports bucket.
 * Each message is one S3Event with typically one record. We download the
 * CSV, parse, check suppressions, upsert contacts, and update the IMPORT
 * record with counts + status.
 */
export const handler: SQSHandler = async (event) => {
  for (const record of event.Records) {
    await processSqsRecord(record);
  }
};

async function processSqsRecord(record: SQSRecord): Promise<void> {
  let s3Event: S3Event;
  try {
    s3Event = JSON.parse(record.body) as S3Event;
  } catch {
    console.error(JSON.stringify({ level: 'error', msg: 'non-json SQS body', body: record.body.slice(0, 200) }));
    return;
  }
  for (const s3rec of s3Event.Records ?? []) {
    await processS3Record(s3rec);
  }
}

async function processS3Record(rec: S3EventRecord): Promise<void> {
  const bucket = rec.s3.bucket.name;
  const key = decodeURIComponent(rec.s3.object.key.replace(/\+/g, ' '));
  const importId = extractImportId(key);
  if (!importId) {
    console.error(JSON.stringify({ level: 'error', msg: 'cannot extract importId', key }));
    return;
  }
  console.log(JSON.stringify({ level: 'info', msg: 'import-start', importId, bucket, key }));

  const meta = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: { PK: `IMPORT#${importId}`, SK: 'META' } }),
  );
  // New shape: assignTags is a string[]. Legacy records may have a single
  // `assignTag` string instead — fall back so we don't break in-flight
  // imports that crossed a deploy boundary.
  const assignTags: string[] =
    (meta.Item?.assignTags as string[] | undefined)
    ?? (meta.Item?.assignTag ? [meta.Item.assignTag as string] : []);

  await setImportStatus(importId, 'processing');

  try {
    const text = await readObject(bucket, key);
    const rows = parseCSV(text);
    const counts: ImportCounts = { total: rows.length, inserted: 0, updated: 0, suppressed: 0, invalid: 0 };

    // Per-row failure log surfaced to the operator via the import banner.
    // `recordFailure` enforces the MAX_FAILURES cap and flips the
    // `truncated` flag once exceeded so the UI can warn that the list is
    // partial. Aggregate counts above are unaffected by the cap.
    const failures: ImportFailure[] = [];
    let failuresTruncated = false;
    const recordFailure = (email: string, reason: ImportFailure['reason']): void => {
      if (failures.length < MAX_FAILURES) {
        failures.push({
          email: email.slice(0, MAX_FAILURE_EMAIL_LENGTH),
          reason,
        });
      } else {
        failuresTruncated = true;
      }
    };

    // Dedupe by lowercased email. The same address appearing multiple times
    // in a single CSV is collapsed to one DDB write, but its eventual outcome
    // (inserted / updated / suppressed) is tallied against EVERY occurrence
    // so the per-row counters still sum to `total`. Invalid-email rows are
    // tallied immediately, one per CSV row, and don't reach the chunker.
    const byEmail = new Map<string, { row: Record<string, string>; occurrences: number }>();
    for (const row of rows) {
      const rawEmail = row.email ?? '';
      const email = rawEmail.trim().toLowerCase();
      if (!EMAIL_RE.test(email)) {
        counts.invalid++;
        recordFailure(rawEmail, 'invalid');
        continue;
      }
      const entry = byEmail.get(email);
      if (entry) {
        entry.row = row;
        entry.occurrences++;
      } else {
        byEmail.set(email, { row, occurrences: 1 });
      }
    }

    const uniqueEmails = [...byEmail.keys()];
    for (let i = 0; i < uniqueEmails.length; i += IMPORT_CHUNK_SIZE) {
      const chunk = uniqueEmails.slice(i, i + IMPORT_CHUNK_SIZE);
      await processChunk(chunk, byEmail, assignTags, counts, importId, recordFailure);
    }

    await setImportStatus(importId, 'done', { counts, failures, failuresTruncated });
    console.log(
      JSON.stringify({
        level: 'info',
        msg: 'import-done',
        importId,
        counts,
        failureCount: failures.length,
        failuresTruncated,
      }),
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(JSON.stringify({ level: 'error', msg: 'import-failed', importId, err: msg }));
    await setImportStatus(importId, 'failed', undefined, msg);
    throw e;
  }
}

// ── Dynamo operations ──────────────────────────────────────────────────────

interface ImportCounts {
  total: number;
  inserted: number;
  updated: number;
  suppressed: number;
  invalid: number;
}

interface ImportFailure {
  /** For `invalid`: the raw email-cell value from the CSV row, truncated.
   *  For `suppressed`: the lowercased valid email that was skipped. */
  email: string;
  reason: 'invalid' | 'suppressed';
}

interface ImportResult {
  counts: ImportCounts;
  failures: ImportFailure[];
  failuresTruncated: boolean;
}

/**
 * Processes one chunk of unique emails: bulk-fetches their existing profiles
 * AND their SUPP-GLOBAL rows in parallel, classifies each row, accumulates
 * profile + tag-link writes, and flushes them through `batchWriteAll`.
 *
 * The SUPP-GLOBAL BatchGet is a belt-and-suspenders defense: the contact
 * profile carries denormalized `suppressedGlobal` flags that should be in
 * sync with the SUPP rows, but if drift ever occurred (manual DDB edits,
 * partially-failed prior suppression write), the SUPP row would be the
 * authoritative source. When we detect drift (SUPP says suppressed but the
 * profile flag is missing) we log a structured warning and still skip the
 * row — we deliberately do not repair the flag here to keep the hot path
 * write-light.
 */
async function processChunk(
  emails: string[],
  byEmail: Map<string, { row: Record<string, string>; occurrences: number }>,
  assignTags: string[],
  counts: ImportCounts,
  importId: string,
  recordFailure: (email: string, reason: ImportFailure['reason']) => void,
): Promise<void> {
  const [profileItems, suppItems] = await Promise.all([
    batchGetAll<Record<string, unknown>>(
      ddb,
      TABLE,
      emails.map((e) => ({ PK: `CONTACT#${e}`, SK: 'PROFILE' })),
    ),
    batchGetAll<Record<string, unknown>>(
      ddb,
      TABLE,
      emails.map((e) => ({ PK: `SUPP#${e}`, SK: 'TYPE#GLOBAL' })),
    ),
  ]);

  const profileByEmail = new Map<string, Record<string, unknown>>();
  for (const item of profileItems) {
    const e = item.email;
    if (typeof e === 'string') profileByEmail.set(e, item);
  }
  const suppGlobalEmails = new Set<string>();
  for (const item of suppItems) {
    const e = item.email;
    if (typeof e === 'string') suppGlobalEmails.add(e);
  }

  const writes: { PutRequest?: unknown; DeleteRequest?: unknown }[] = [];
  for (const email of emails) {
    const entry = byEmail.get(email);
    if (!entry) continue; // unreachable, but keeps TS happy
    const { row, occurrences } = entry;
    const existing = profileByEmail.get(email);
    const profileSaysSuppressed = existingSuppressed(existing);
    const suppRowExists = suppGlobalEmails.has(email);

    if (profileSaysSuppressed || suppRowExists) {
      // Drift case: profile exists and didn't claim suppression, but a
      // SUPP-GLOBAL row exists. Worth surfacing — without the SUPP-row
      // BatchGet we'd have re-admitted a globally-suppressed address.
      if (suppRowExists && existing && !profileSaysSuppressed) {
        console.warn(
          JSON.stringify({
            level: 'warn',
            msg: 'suppression-denorm-drift',
            importId,
            email,
          }),
        );
      }
      counts.suppressed += occurrences;
      recordFailure(email, 'suppressed');
      continue;
    }

    const requests = buildContactWrites(email, row, existing, assignTags);
    for (const r of requests) writes.push(r);
    if (existing) counts.updated += occurrences;
    else counts.inserted += occurrences;
  }

  if (writes.length > 0) {
    await batchWriteAll(ddb, TABLE, writes);
  }
}

/**
 * Builds the DDB write requests for a single contact (profile Put + tag-link
 * Puts for newly assigned tags). Mirrors the prior single-row upsert
 * semantics: the CSV's name (or email local-part fallback) always wins; the
 * CSV's org wins when present and falls back to the existing value when the
 * CSV cell is empty; existing `status` of `unsubscribed`/`bounced` is
 * preserved (never reset by a re-import); every suppression-related
 * attribute on the existing row is copied forward because PutCommand
 * wholesale-replaces items.
 */
function buildContactWrites(
  email: string,
  row: Record<string, string>,
  existing: Record<string, unknown> | undefined,
  assignTags: string[],
): { PutRequest?: unknown; DeleteRequest?: unknown }[] {
  const prevTags = (existing?.tags as string[] | undefined) ?? [];
  const newTags = assignTags.filter((t) => !prevTags.includes(t));
  const tags = newTags.length > 0 ? [...prevTags, ...newTags] : prevTags;
  const now = new Date().toISOString();
  const status =
    existing?.status === 'unsubscribed' || existing?.status === 'bounced'
      ? existing.status
      : 'active';
  const name = (row.name ?? '').trim() || email.split('@')[0];
  const orgFromRow = (row.org ?? row.organization ?? row.institution ?? '').trim();
  const org = orgFromRow || (existing?.org as string | undefined);

  const profile: Record<string, unknown> = {
    PK: `CONTACT#${email}`,
    SK: 'PROFILE',
    email,
    name,
    org,
    tags,
    status,
    joined: existing?.joined ?? now.slice(0, 10),
    updatedAt: now,
    suppressed: existing?.suppressed === true,
    suppressedGlobal: existing?.suppressedGlobal === true,
    suppressedAt: existing?.suppressedAt,
    suppressionReason: existing?.suppressionReason,
    ...contactStatusIndexFields(email, status),
  };
  // DDB drops empty Sets, so only attach `suppressedTypes` when we have at
  // least one type to preserve.
  const types = readPreservedTypeSet(existing?.suppressedTypes);
  if (types.length > 0) profile.suppressedTypes = new Set(types);

  return [
    { PutRequest: { Item: profile } },
    ...newTags.map((t) => ({
      PutRequest: {
        Item: {
          PK: `CONTACT#${email}`,
          SK: `TAG#${t}`,
          GSI1PK: `TAG#${t}`,
          GSI1SK: `CONTACT#${email}`,
          email,
        },
      },
    })),
  ];
}

async function setImportStatus(
  importId: string,
  status: string,
  result?: ImportResult,
  errorMsg?: string,
): Promise<void> {
  const parts: string[] = ['#s = :s', 'updatedAt = :u'];
  const values: Record<string, unknown> = { ':s': status, ':u': new Date().toISOString() };
  const names: Record<string, string> = { '#s': 'status' };
  if (result) {
    parts.push('counts = :c');
    values[':c'] = result.counts;
    // Always persist `failures` so the UI can rely on its presence — an
    // empty array means "import succeeded with nothing to report" rather
    // than "we don't know yet". Same for the truncated flag.
    parts.push('failures = :f');
    values[':f'] = result.failures;
    parts.push('failuresTruncated = :ft');
    values[':ft'] = result.failuresTruncated;
  }
  if (errorMsg) { parts.push('#e = :e'); values[':e'] = errorMsg; names['#e'] = 'error'; }
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { PK: `IMPORT#${importId}`, SK: 'META' },
      UpdateExpression: 'SET ' + parts.join(', '),
      ExpressionAttributeValues: values,
      ExpressionAttributeNames: names,
    }),
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────

async function readObject(bucket: string, key: string): Promise<string> {
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return await res.Body!.transformToString('utf-8');
}

function extractImportId(key: string): string | null {
  // imports/<uuid>.csv
  const m = key.match(/^imports\/([0-9a-f-]{36})\.csv$/i);
  return m ? m[1] : null;
}

function readPreservedTypeSet(value: unknown): string[] {
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

function existingSuppressed(item: Record<string, unknown> | undefined): boolean {
  // CSV import skips contacts with a hard global suppression (bounce,
  // complaint, or operator opt-out-of-everything). Per-type suppressions
  // don't block import — the address is still a valid recipient for any
  // newsletter type they haven't opted out of.
  if (!item) return false;
  if (item.suppressedGlobal === true) return true;
  // Pre-migration legacy rows store only the flat `suppressed` boolean;
  // treat them as global so we don't accidentally re-import a bouncing
  // address that hasn't been migrated yet.
  if (item.suppressedGlobal === undefined && item.suppressed === true) return true;
  return false;
}

/**
 * Minimal RFC-4180-ish CSV parser: handles quoted fields, embedded commas,
 * escaped quotes (""), and \n or \r\n line breaks. Returns an array of
 * row objects keyed by lowercased header.
 */
function parseCSV(text: string): Record<string, string>[] {
  const rows: string[][] = [[]];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === ',') { rows[rows.length - 1].push(field); field = ''; continue; }
    if (c === '\n' || c === '\r') {
      rows[rows.length - 1].push(field); field = '';
      if (c === '\r' && text[i + 1] === '\n') i++;
      rows.push([]);
      continue;
    }
    field += c;
  }
  rows[rows.length - 1].push(field);

  // drop trailing empty row (common from files ending with \n)
  while (rows.length > 0 && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === '') rows.pop();

  if (rows.length === 0) return [];
  const headers = rows[0].map((h) => h.trim().toLowerCase());
  return rows.slice(1).map((r) => {
    const o: Record<string, string> = {};
    headers.forEach((h, idx) => { o[h] = (r[idx] ?? '').trim(); });
    return o;
  });
}

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}
