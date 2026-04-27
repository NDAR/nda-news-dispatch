import {
  DynamoDBDocumentClient,
  DeleteCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';

/**
 * Suppression scope.
 *
 * GLOBAL — blocks every send to this email forever. Reserved for deliverability
 *   signals (hard bounces, ISP complaints) and explicit operator-set "stop
 *   everything" suppressions.
 * TYPE   — blocks sends only when the campaign's typeId matches. The product
 *   of a per-newsletter unsubscribe.
 *
 * The two layers compose: a send is blocked if EITHER a global SUPP row
 * exists for the recipient OR a per-type SUPP row exists for that
 * recipient + the campaign's typeId.
 */
export type SuppressionScope = 'global' | 'type';

export type SuppressionReason =
  | 'bounce'
  | 'complaint'
  | 'unsubscribe'
  | 'manual';

export const VALID_SUPPRESSION_REASONS: readonly SuppressionReason[] = [
  'bounce',
  'complaint',
  'unsubscribe',
  'manual',
] as const;

export const GLOBAL_SCOPE_SK = 'TYPE#GLOBAL';

export function suppressionScopeSk(scope: SuppressionScope, typeId?: string): string {
  if (scope === 'global') return GLOBAL_SCOPE_SK;
  if (!typeId) throw new Error('typeId is required for type-scoped suppression');
  return `TYPE#${typeId}`;
}

/**
 * Parse a SUPP row's SK to recover the scope and typeId. Returns null on
 * unrecognized shapes (lets callers ignore stray rows during migration).
 */
export function parseSuppressionSk(sk: string): { scope: SuppressionScope; typeId?: string } | null {
  if (sk === GLOBAL_SCOPE_SK) return { scope: 'global' };
  if (sk.startsWith('TYPE#')) {
    const typeId = sk.slice('TYPE#'.length);
    if (!typeId || typeId === 'GLOBAL') return null;
    return { scope: 'type', typeId };
  }
  // Legacy shape: REASON#<reason>. Treat as global for the duration of the
  // migration window so reads remain correct even before the migrator runs.
  if (sk.startsWith('REASON#')) return { scope: 'global' };
  return null;
}

export interface ApplySuppressionInput {
  email: string;
  scope: SuppressionScope;
  typeId?: string;
  reason: SuppressionReason;
  source: string;
  campaignId?: string;
  messageId?: string;
  note?: string;
  addedBy?: string;
  at?: string;
}

/**
 * Writes a SUPP row and updates the CONTACT PROFILE denormalized hints
 * (`suppressedGlobal` / `suppressedTypes`) so the audience query stays a
 * single GSI scan. The CONTACT update is best-effort — a missing profile
 * (e.g. forwarded mail to an address we don't track) is not an error.
 */
export async function applySuppression(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  input: ApplySuppressionInput,
): Promise<void> {
  const at = input.at ?? new Date().toISOString();
  const sk = suppressionScopeSk(input.scope, input.typeId);

  await ddb.send(
    new PutCommand({
      TableName: tableName,
      Item: {
        PK: `SUPP#${input.email}`,
        SK: sk,
        email: input.email,
        scope: input.scope,
        typeId: input.scope === 'type' ? input.typeId : undefined,
        reason: input.reason,
        source: input.source,
        campaignId: input.campaignId,
        messageId: input.messageId,
        note: input.note,
        addedBy: input.addedBy,
        addedAt: at,
      },
    }),
  );

  await touchContactSuppressionFlags(ddb, tableName, input.email, {
    addGlobal: input.scope === 'global',
    addType: input.scope === 'type' ? input.typeId : undefined,
  }).catch((e) => {
    // CONTACT PROFILE may not exist for forwarded mail; SUPP row alone is
    // enough to block future sends.
    const msg = e instanceof Error ? e.message : String(e);
    console.log(JSON.stringify({ level: 'info', msg: 'suppression-contact-skip', email: input.email, err: msg }));
  });
}

export interface RemoveSuppressionInput {
  email: string;
  scope: SuppressionScope;
  typeId?: string;
}

/** Deletes a single scoped SUPP row and refreshes the CONTACT denorm hints. */
export async function removeSuppression(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  input: RemoveSuppressionInput,
): Promise<void> {
  const sk = suppressionScopeSk(input.scope, input.typeId);
  await ddb.send(
    new DeleteCommand({
      TableName: tableName,
      Key: { PK: `SUPP#${input.email}`, SK: sk },
    }),
  );
  await refreshContactSuppressionFlags(ddb, tableName, input.email);
}

/** Deletes every SUPP row for an email and clears the CONTACT denorm hints. */
export async function removeAllSuppressions(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  email: string,
): Promise<number> {
  const items = await listSuppressionsForEmail(ddb, tableName, email);
  await Promise.all(
    items.map((item) =>
      ddb.send(
        new DeleteCommand({
          TableName: tableName,
          Key: { PK: item.PK, SK: item.SK },
        }),
      ),
    ),
  );
  await clearContactSuppressionFlags(ddb, tableName, email);
  return items.length;
}

export interface SuppressionRow {
  PK: string;
  SK: string;
  email: string;
  scope: SuppressionScope;
  typeId?: string;
  reason: SuppressionReason;
  source?: string;
  campaignId?: string;
  messageId?: string;
  note?: string;
  addedBy?: string;
  addedAt: string;
}

export async function listSuppressionsForEmail(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  email: string,
): Promise<SuppressionRow[]> {
  const res = await ddb.send(
    new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': `SUPP#${email}`, ':sk': 'TYPE#' },
    }),
  );
  return (res.Items ?? []).map((item) => normalizeSuppressionRow(item, email));
}

function normalizeSuppressionRow(item: Record<string, unknown>, email: string): SuppressionRow {
  const sk = String(item.SK ?? '');
  const parsed = parseSuppressionSk(sk);
  const scope: SuppressionScope = parsed?.scope ?? 'global';
  const typeId = parsed?.typeId;
  const reason = (item.reason as SuppressionReason | undefined) ?? 'manual';
  return {
    PK: String(item.PK ?? `SUPP#${email}`),
    SK: sk,
    email: String(item.email ?? email),
    scope,
    typeId,
    reason,
    source: item.source as string | undefined,
    campaignId: item.campaignId as string | undefined,
    messageId: item.messageId as string | undefined,
    note: item.note as string | undefined,
    addedBy: item.addedBy as string | undefined,
    addedAt: String(item.addedAt ?? ''),
  };
}

interface TouchOptions {
  addGlobal: boolean;
  addType?: string;
}

async function touchContactSuppressionFlags(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  email: string,
  opts: TouchOptions,
): Promise<void> {
  const sets: string[] = ['updatedAt = :u'];
  const adds: string[] = [];
  const values: Record<string, unknown> = { ':u': new Date().toISOString() };
  if (opts.addGlobal) {
    sets.push('suppressedGlobal = :true', 'suppressed = :true');
    values[':true'] = true;
  }
  if (opts.addType) {
    adds.push('suppressedTypes :tset');
    values[':tset'] = new Set([opts.addType]);
    // Keep legacy `suppressed` flag truthy as a derived view: any per-type
    // suppression also marks the contact as "suppressed" overall, matching
    // the SPA's existing pill behavior. The audience filter no longer
    // consults this attribute.
    sets.push('suppressed = :true');
    values[':true'] = true;
  }
  const expr = (sets.length > 0 ? 'SET ' + sets.join(', ') : '')
    + (adds.length > 0 ? ' ADD ' + adds.join(', ') : '');
  await ddb.send(
    new UpdateCommand({
      TableName: tableName,
      Key: { PK: `CONTACT#${email}`, SK: 'PROFILE' },
      UpdateExpression: expr,
      ConditionExpression: 'attribute_exists(PK)',
      ExpressionAttributeValues: values,
    }),
  );
}

/**
 * Re-derive `suppressedGlobal`, `suppressedTypes`, and the legacy
 * `suppressed` flag from the SUPP rows that currently exist for this email.
 * Called after any DELETE so the contact denorm reflects reality.
 */
async function refreshContactSuppressionFlags(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  email: string,
): Promise<void> {
  const rows = await listSuppressionsForEmail(ddb, tableName, email);
  const hasGlobal = rows.some((r) => r.scope === 'global');
  const types = rows.filter((r) => r.scope === 'type' && r.typeId).map((r) => r.typeId!);
  const stillSuppressed = hasGlobal || types.length > 0;

  if (!stillSuppressed) {
    await clearContactSuppressionFlags(ddb, tableName, email);
    return;
  }

  const sets: string[] = [
    'suppressedGlobal = :g',
    'suppressed = :true',
    'updatedAt = :u',
  ];
  const removes: string[] = [];
  const values: Record<string, unknown> = {
    ':g': hasGlobal,
    ':true': true,
    ':u': new Date().toISOString(),
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
      TableName: tableName,
      Key: { PK: `CONTACT#${email}`, SK: 'PROFILE' },
      UpdateExpression: expr,
      ConditionExpression: 'attribute_exists(PK)',
      ExpressionAttributeValues: values,
    }),
  ).catch(() => undefined);
}

async function clearContactSuppressionFlags(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  email: string,
): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: tableName,
      Key: { PK: `CONTACT#${email}`, SK: 'PROFILE' },
      UpdateExpression:
        'SET suppressedGlobal = :false, suppressed = :false, updatedAt = :u REMOVE suppressedTypes, suppressedAt, suppressionReason',
      ConditionExpression: 'attribute_exists(PK)',
      ExpressionAttributeValues: {
        ':false': false,
        ':u': new Date().toISOString(),
      },
    }),
  ).catch(() => undefined);
}
