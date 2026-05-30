import {
  BatchGetCommand,
  BatchWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import {
  SendMessageBatchCommand,
  type SendMessageBatchRequestEntry,
  type SQSClient,
} from '@aws-sdk/client-sqs';

const MAX_BATCH_RETRIES = 5;
const BASE_DELAY_MS = 50;

export interface SendBatchFailure<T extends SendMessageBatchRequestEntry> {
  entry: T;
  code?: string;
  message?: string;
  senderFault?: boolean;
}

export async function batchWriteAll(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  requests: { PutRequest?: unknown; DeleteRequest?: unknown }[],
): Promise<void> {
  for (let i = 0; i < requests.length; i += 25) {
    let pending = requests.slice(i, i + 25);
    if (pending.length === 0) continue;
    for (let attempt = 0; attempt <= MAX_BATCH_RETRIES; attempt++) {
      const res = await ddb.send(
        new BatchWriteCommand({ RequestItems: { [tableName]: pending as never[] } }),
      );
      pending = (res.UnprocessedItems?.[tableName] ?? []) as typeof pending;
      if (pending.length === 0) break;
      if (attempt === MAX_BATCH_RETRIES) {
        throw new Error(`BatchWrite exhausted retries with ${pending.length} unprocessed items`);
      }
      await sleep(backoffMs(attempt));
    }
  }
}

/**
 * Fan-out concurrency for the parallel-chunk loop. DynamoDB BatchGetItem
 * caps each call at 100 keys, so we have to chunk regardless; the only
 * question is whether the chunks run sequentially or in waves.
 *
 * The original implementation ran one chunk at a time, which meant a
 * 45 K-row materialization took ~450 sequential round-trips ≈ 13 s. With
 * 8-way fan-out the same workload finishes in ~56 waves, which is
 * roughly an order of magnitude faster. Higher concurrency would help
 * proportionally but increases the risk of provisioned-throughput
 * throttling on the underlying table, especially when callers are
 * already running other DDB work in parallel.
 *
 * The output is a flat array of results across all chunks. We do NOT
 * guarantee output order matches input order — every caller in this
 * repo indexes results by email (or another PK field) into a Map, so
 * ordering wasn't relied on even when the loop was sequential.
 */
const BATCH_GET_CONCURRENCY = 8;

export async function batchGetAll<T extends Record<string, unknown>>(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  keys: Record<string, unknown>[],
): Promise<T[]> {
  if (keys.length === 0) return [];

  const chunks: Record<string, unknown>[][] = [];
  for (let i = 0; i < keys.length; i += 100) {
    chunks.push(keys.slice(i, i + 100));
  }

  const out: T[] = [];
  for (let i = 0; i < chunks.length; i += BATCH_GET_CONCURRENCY) {
    const wave = chunks.slice(i, i + BATCH_GET_CONCURRENCY);
    const waveResults = await Promise.all(wave.map((chunk) => doBatchGet<T>(ddb, tableName, chunk)));
    for (const arr of waveResults) out.push(...arr);
  }
  return out;
}

/**
 * Runs one BatchGetItem of up to 100 keys, retrying any
 * `UnprocessedKeys` with exponential backoff. Inlined per-chunk so each
 * parallel worker can independently resolve its own retries without
 * coordinating with siblings — UnprocessedKeys is per-call, not
 * per-table-wide.
 */
async function doBatchGet<T extends Record<string, unknown>>(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  chunk: Record<string, unknown>[],
): Promise<T[]> {
  const local: T[] = [];
  let pending = chunk;
  for (let attempt = 0; attempt <= MAX_BATCH_RETRIES; attempt++) {
    const res = await ddb.send(
      new BatchGetCommand({
        RequestItems: { [tableName]: { Keys: pending } },
      }),
    );
    local.push(...((res.Responses?.[tableName] ?? []) as T[]));
    pending = (res.UnprocessedKeys?.[tableName]?.Keys ?? []) as typeof pending;
    if (pending.length === 0) return local;
    if (attempt === MAX_BATCH_RETRIES) {
      throw new Error(`BatchGet exhausted retries with ${pending.length} unprocessed keys`);
    }
    await sleep(backoffMs(attempt));
  }
  return local;
}

export async function sendMessageBatchAll<T extends SendMessageBatchRequestEntry>(
  sqs: SQSClient,
  queueUrl: string,
  entries: T[],
): Promise<{ successful: T[]; failed: SendBatchFailure<T>[] }> {
  const successful: T[] = [];
  const failed: SendBatchFailure<T>[] = [];

  for (let i = 0; i < entries.length; i += 10) {
    const chunk = entries.slice(i, i + 10);
    const originalById = new Map(chunk.map((entry) => [entry.Id, entry]));
    let pending = new Map(chunk.map((entry) => [entry.Id, entry]));

    for (let attempt = 0; attempt <= MAX_BATCH_RETRIES && pending.size > 0; attempt++) {
      const res = await sqs.send(
        new SendMessageBatchCommand({
          QueueUrl: queueUrl,
          Entries: [...pending.values()],
        }),
      );

      for (const sent of res.Successful ?? []) {
        if (!sent.Id) continue;
        const entry = pending.get(sent.Id);
        if (!entry) continue;
        successful.push(entry);
        pending.delete(sent.Id);
      }

      const retryable = new Map<string, T>();
      for (const err of res.Failed ?? []) {
        const entry = err.Id ? originalById.get(err.Id) : undefined;
        if (!entry) continue;
        if (!err.SenderFault && attempt < MAX_BATCH_RETRIES) {
          retryable.set(entry.Id, entry);
          continue;
        }
        failed.push({ entry, code: err.Code, message: err.Message, senderFault: err.SenderFault });
        pending.delete(entry.Id);
      }

      if (retryable.size === 0) break;
      pending = retryable;
      await sleep(backoffMs(attempt));
    }

    if (pending.size > 0) {
      for (const entry of pending.values()) {
        failed.push({ entry, code: 'BatchRetryExhausted', message: 'SQS batch retry budget exhausted' });
      }
    }
  }

  return { successful, failed };
}

function backoffMs(attempt: number): number {
  return Math.min(1_000, BASE_DELAY_MS * (2 ** attempt));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
