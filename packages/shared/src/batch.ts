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

export async function batchGetAll<T extends Record<string, unknown>>(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  keys: Record<string, unknown>[],
): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < keys.length; i += 100) {
    let pending = keys.slice(i, i + 100);
    if (pending.length === 0) continue;
    for (let attempt = 0; attempt <= MAX_BATCH_RETRIES; attempt++) {
      const res = await ddb.send(
        new BatchGetCommand({
          RequestItems: {
            [tableName]: {
              Keys: pending,
            },
          },
        }),
      );
      out.push(...((res.Responses?.[tableName] ?? []) as T[]));
      pending = (res.UnprocessedKeys?.[tableName]?.Keys ?? []) as typeof pending;
      if (pending.length === 0) break;
      if (attempt === MAX_BATCH_RETRIES) {
        throw new Error(`BatchGet exhausted retries with ${pending.length} unprocessed keys`);
      }
      await sleep(backoffMs(attempt));
    }
  }
  return out;
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
