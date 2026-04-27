#!/usr/bin/env -S npx tsx
/**
 * One-shot migrator: legacy `SUPP#<email> / REASON#<reason>` rows → new
 * scoped shape `SUPP#<email> / TYPE#GLOBAL` (bounces / complaints / manual)
 * or `TYPE#<typeId>` (per-newsletter unsubscribes).
 *
 * Idempotent: running twice is a no-op. Safe to run mid-deploy because
 * the production code already reads both shapes during the migration window.
 *
 * Usage:
 *   npx tsx scripts/migrate-suppressions.ts \
 *     --table nda-dispatch-dev \
 *     --region us-east-1 \
 *     --dry-run
 *
 *   # then, when happy:
 *   npx tsx scripts/migrate-suppressions.ts \
 *     --table nda-dispatch-dev --region us-east-1
 *
 * What it does for each `SUPP#<email>` partition:
 *   1. Reads every legacy `REASON#<reason>` row.
 *   2. Maps it to a new scope:
 *        - bounce / complaint / manual               → TYPE#GLOBAL
 *        - unsubscribe with campaignId → typeId      → TYPE#<typeId>
 *        - unsubscribe with no resolvable typeId     → TYPE#GLOBAL (safe default)
 *   3. Writes the new row.
 *   4. Refreshes the CONTACT PROFILE denorm flags
 *      (`suppressedGlobal`, `suppressedTypes` String Set).
 *   5. Deletes the legacy row only after the new row is confirmed written.
 *   6. Emits a CSV row to stdout: email,oldReason,newScope,newTypeId,actionTaken
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  DeleteCommand,
  GetCommand,
  PutCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';

interface Args {
  table: string;
  region: string;
  dryRun: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let table = process.env.TABLE_NAME ?? '';
  let region = process.env.AWS_REGION ?? 'us-east-1';
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--table') table = argv[++i] ?? '';
    else if (a === '--region') region = argv[++i] ?? region;
    else if (a === '--dry-run') dryRun = true;
    else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    } else {
      console.error(`Unknown flag: ${a}`);
      printHelp();
      process.exit(1);
    }
  }
  if (!table) {
    console.error('Missing --table (or TABLE_NAME env)');
    printHelp();
    process.exit(1);
  }
  return { table, region, dryRun };
}

function printHelp(): void {
  console.log(`Usage: migrate-suppressions.ts --table <name> [--region us-east-1] [--dry-run]`);
}

const args = parseArgs();
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: args.region }), {
  marshallOptions: { removeUndefinedValues: true },
});

interface LegacyRow {
  PK: string;
  SK: string;
  email: string;
  reason: string;
  source?: string;
  campaignId?: string;
  messageId?: string;
  note?: string;
  addedBy?: string;
  addedAt?: string;
}

async function* iterateLegacyRows(): AsyncGenerator<LegacyRow> {
  let cursor: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(
      new ScanCommand({
        TableName: args.table,
        FilterExpression: 'begins_with(PK, :p) AND begins_with(SK, :s)',
        ExpressionAttributeValues: { ':p': 'SUPP#', ':s': 'REASON#' },
        ExclusiveStartKey: cursor,
      }),
    );
    for (const item of res.Items ?? []) {
      yield item as unknown as LegacyRow;
    }
    cursor = res.LastEvaluatedKey;
  } while (cursor);
}

const typeIdCache = new Map<string, string | null>();

async function resolveTypeIdForCampaign(campaignId: string | undefined): Promise<string | null> {
  if (!campaignId) return null;
  if (typeIdCache.has(campaignId)) return typeIdCache.get(campaignId) ?? null;
  const res = await ddb.send(
    new GetCommand({ TableName: args.table, Key: { PK: `CAMPAIGN#${campaignId}`, SK: 'META' } }),
  );
  const id = typeof res.Item?.typeId === 'string' ? res.Item.typeId : null;
  typeIdCache.set(campaignId, id);
  return id;
}

async function decideTarget(row: LegacyRow): Promise<{
  scope: 'global' | 'type';
  typeId?: string;
}> {
  const reason = row.reason?.toLowerCase() ?? 'manual';
  if (reason === 'bounce' || reason === 'complaint' || reason === 'manual') {
    return { scope: 'global' };
  }
  if (reason === 'unsubscribe') {
    const typeId = await resolveTypeIdForCampaign(row.campaignId);
    if (typeId) return { scope: 'type', typeId };
    return { scope: 'global' };
  }
  // Unknown reason — treat as global to stay safe.
  return { scope: 'global' };
}

function newSk(scope: 'global' | 'type', typeId?: string): string {
  return scope === 'global' ? 'TYPE#GLOBAL' : `TYPE#${typeId}`;
}

async function rowExists(pk: string, sk: string): Promise<boolean> {
  const res = await ddb.send(new GetCommand({ TableName: args.table, Key: { PK: pk, SK: sk } }));
  return !!res.Item;
}

async function migrateOne(row: LegacyRow): Promise<{
  email: string;
  oldReason: string;
  newScope: string;
  newTypeId: string;
  action: string;
}> {
  const target = await decideTarget(row);
  const sk = newSk(target.scope, target.typeId);
  const newPk = row.PK;
  const action: string[] = [];

  if (await rowExists(newPk, sk)) {
    action.push('new-row-exists');
  } else if (args.dryRun) {
    action.push('would-write-new-row');
  } else {
    await ddb.send(
      new PutCommand({
        TableName: args.table,
        Item: {
          PK: newPk,
          SK: sk,
          email: row.email,
          scope: target.scope,
          typeId: target.scope === 'type' ? target.typeId : undefined,
          reason: row.reason ?? 'manual',
          source: row.source ?? 'migrated',
          campaignId: row.campaignId,
          messageId: row.messageId,
          note: row.note,
          addedBy: row.addedBy,
          addedAt: row.addedAt ?? new Date().toISOString(),
        },
      }),
    );
    action.push('wrote-new-row');
  }

  // Refresh the CONTACT PROFILE denorm hint. We do this even when the new row
  // already existed so we backfill `suppressedGlobal` / `suppressedTypes` on
  // contacts that predate the migrator.
  if (!args.dryRun) {
    await touchContact(row.email, target);
    action.push('touched-contact');
  } else {
    action.push('would-touch-contact');
  }

  // Delete the legacy row only after the new row is in place.
  if (args.dryRun) {
    action.push('would-delete-legacy');
  } else {
    await ddb.send(
      new DeleteCommand({ TableName: args.table, Key: { PK: row.PK, SK: row.SK } }),
    );
    action.push('deleted-legacy');
  }

  return {
    email: row.email,
    oldReason: row.reason ?? '',
    newScope: target.scope,
    newTypeId: target.typeId ?? '',
    action: action.join(';'),
  };
}

async function touchContact(
  email: string,
  target: { scope: 'global' | 'type'; typeId?: string },
): Promise<void> {
  const sets: string[] = ['updatedAt = :u', 'suppressed = :true'];
  const adds: string[] = [];
  const values: Record<string, unknown> = {
    ':u': new Date().toISOString(),
    ':true': true,
  };
  if (target.scope === 'global') {
    sets.push('suppressedGlobal = :true');
  } else if (target.typeId) {
    adds.push('suppressedTypes :tset');
    values[':tset'] = new Set([target.typeId]);
  }
  const expr = 'SET ' + sets.join(', ') + (adds.length > 0 ? ' ADD ' + adds.join(', ') : '');
  await ddb.send(
    new UpdateCommand({
      TableName: args.table,
      Key: { PK: `CONTACT#${email}`, SK: 'PROFILE' },
      UpdateExpression: expr,
      ConditionExpression: 'attribute_exists(PK)',
      ExpressionAttributeValues: values,
    }),
  ).catch(() => undefined); // missing contact is fine
}

async function main(): Promise<void> {
  console.error(
    `[migrate] table=${args.table} region=${args.region} dryRun=${args.dryRun}`,
  );
  console.log('email,oldReason,newScope,newTypeId,action');
  let count = 0;
  let errors = 0;
  for await (const row of iterateLegacyRows()) {
    try {
      const out = await migrateOne(row);
      console.log(
        [out.email, out.oldReason, out.newScope, out.newTypeId, out.action]
          .map(csvField)
          .join(','),
      );
      count++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[migrate] error on ${row.PK}/${row.SK}: ${msg}`);
      errors++;
    }
  }
  console.error(`[migrate] processed=${count} errors=${errors}`);
  if (errors > 0) process.exit(2);
}

function csvField(v: string): string {
  if (/[",\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
