import type { SQSHandler, SQSEvent, SQSRecord, S3Event, S3EventRecord } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  BatchWriteCommand,
  UpdateCommand,
  GetCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const s3 = new S3Client({});
const TABLE = mustEnv('TABLE_NAME');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
    const counts = { total: rows.length, inserted: 0, updated: 0, suppressed: 0, invalid: 0 };

    for (const row of rows) {
      const email = (row.email ?? '').trim().toLowerCase();
      if (!EMAIL_RE.test(email)) {
        counts.invalid++;
        continue;
      }
      if (await isSuppressed(email)) {
        counts.suppressed++;
        continue;
      }
      const existed = await upsertContact({
        email,
        name: (row.name ?? '').trim() || email.split('@')[0],
        org: (row.org ?? row.organization ?? row.institution ?? '').trim() || undefined,
        assignTags,
      });
      if (existed) counts.updated++;
      else counts.inserted++;
    }

    await setImportStatus(importId, 'done', counts);
    console.log(JSON.stringify({ level: 'info', msg: 'import-done', importId, counts }));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(JSON.stringify({ level: 'error', msg: 'import-failed', importId, err: msg }));
    await setImportStatus(importId, 'failed', undefined, msg);
    throw e;
  }
}

// ── Dynamo operations ──────────────────────────────────────────────────────

interface ContactUpsert {
  email: string;
  name: string;
  org?: string;
  assignTags: string[];
}

async function upsertContact(c: ContactUpsert): Promise<boolean> {
  const existing = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: { PK: `CONTACT#${c.email}`, SK: 'PROFILE' } }),
  );
  const existed = !!existing.Item;
  const prevTags = (existing.Item?.tags as string[] | undefined) ?? [];
  const newTags = c.assignTags.filter((t) => !prevTags.includes(t));
  const tags = newTags.length > 0 ? [...prevTags, ...newTags] : prevTags;
  const now = new Date().toISOString();

  const profile = {
    PK: `CONTACT#${c.email}`,
    SK: 'PROFILE',
    email: c.email,
    name: c.name || existing.Item?.name || c.email.split('@')[0],
    org: c.org ?? existing.Item?.org,
    tags,
    status: existing.Item?.status ?? 'active',
    joined: existing.Item?.joined ?? now.slice(0, 10),
    updatedAt: now,
  };

  const requests: { PutRequest?: unknown; DeleteRequest?: unknown }[] = [
    { PutRequest: { Item: profile } },
    ...newTags.map((t) => ({
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
  await batchWrite(requests);
  return existed;
}

async function isSuppressed(email: string): Promise<boolean> {
  const res = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': `SUPP#${email}` },
      Limit: 1,
    }),
  );
  return (res.Count ?? 0) > 0;
}

async function setImportStatus(
  importId: string,
  status: string,
  counts?: Record<string, number>,
  errorMsg?: string,
): Promise<void> {
  const parts: string[] = ['#s = :s', 'updatedAt = :u'];
  const values: Record<string, unknown> = { ':s': status, ':u': new Date().toISOString() };
  const names: Record<string, string> = { '#s': 'status' };
  if (counts) { parts.push('counts = :c'); values[':c'] = counts; }
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

async function batchWrite(requests: { PutRequest?: unknown; DeleteRequest?: unknown }[]): Promise<void> {
  for (let i = 0; i < requests.length; i += 25) {
    const chunk = requests.slice(i, i + 25);
    if (chunk.length === 0) continue;
    await ddb.send(new BatchWriteCommand({ RequestItems: { [TABLE]: chunk as never[] } }));
  }
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
