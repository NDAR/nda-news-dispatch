import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { batchGetAll } from './batch';
import {
  contactStatusIndexPk,
  type AudienceProfile,
  toAudienceProfile,
} from './contact-model';

export interface AudienceSelection {
  tagMode: 'all' | 'any';
  tags: string[];
  excludeTags: string[];
  /** Newsletter type the campaign is being sent for. When provided, the
   *  filter drops recipients with a per-type suppression for this typeId in
   *  addition to globally-suppressed recipients. Without a typeId, only
   *  global suppressions block sends — this matches the legacy behavior and
   *  keeps the audience-preview endpoint working for type-less previews. */
  typeId?: string;
}

export async function materializeAudienceProfiles(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  opts: AudienceSelection,
): Promise<AudienceProfile[]> {
  const excludeSets = await Promise.all(opts.excludeTags.map((tag) => queryTagEmails(ddb, tableName, tag)));
  const excluded = union(excludeSets);
  const allow = makeSuppressionFilter(opts.typeId);

  if (opts.tags.length === 0) {
    const activeProfiles = await queryActiveProfiles(ddb, tableName);
    return activeProfiles.filter((profile) => allow(profile) && !excluded.has(profile.email));
  }

  const tagSets = await Promise.all(opts.tags.map((tag) => queryTagEmails(ddb, tableName, tag)));
  const base = opts.tagMode === 'all' ? intersect(tagSets) : union(tagSets);
  const candidates = [...base].filter((email) => !excluded.has(email));
  if (candidates.length === 0) return [];

  const profiles = await batchGetAll<Record<string, unknown>>(
    ddb,
    tableName,
    candidates.map((email) => ({ PK: `CONTACT#${email}`, SK: 'PROFILE' })),
  );
  const byEmail = new Map(profiles.map((item) => {
    const profile = toAudienceProfile(item);
    return [profile.email, profile] as const;
  }));

  return candidates
    .map((email) => byEmail.get(email))
    .filter((profile): profile is AudienceProfile =>
      !!profile && profile.status === 'active' && allow(profile),
    );
}

export async function materializeAudienceEmails(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  opts: AudienceSelection,
): Promise<string[]> {
  const profiles = await materializeAudienceProfiles(ddb, tableName, opts);
  return profiles.map((profile) => profile.email);
}

function makeSuppressionFilter(typeId: string | undefined): (profile: AudienceProfile) => boolean {
  return (profile) => {
    if (profile.suppressedGlobal) return false;
    if (typeId && profile.suppressedTypes.includes(typeId)) return false;
    return true;
  };
}

async function queryActiveProfiles(
  ddb: DynamoDBDocumentClient,
  tableName: string,
): Promise<AudienceProfile[]> {
  const profiles: AudienceProfile[] = [];
  let cursor: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: 'GSI2',
        KeyConditionExpression: 'GSI2PK = :pk',
        ExpressionAttributeValues: { ':pk': contactStatusIndexPk('active') },
        ExclusiveStartKey: cursor,
      }),
    );
    profiles.push(
      ...(res.Items ?? []).map((item: Record<string, unknown>) => toAudienceProfile(item)),
    );
    cursor = res.LastEvaluatedKey;
  } while (cursor);
  return profiles;
}

async function queryTagEmails(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  tag: string,
): Promise<Set<string>> {
  const out = new Set<string>();
  let cursor: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :pk',
        ExpressionAttributeValues: { ':pk': `TAG#${tag}` },
        ProjectionExpression: 'email',
        ExclusiveStartKey: cursor,
      }),
    );
    for (const item of res.Items ?? []) {
      if (typeof item.email === 'string') out.add(item.email);
    }
    cursor = res.LastEvaluatedKey;
  } while (cursor);
  return out;
}

function intersect(sets: Set<string>[]): Set<string> {
  if (sets.length === 0) return new Set();
  const [first, ...rest] = sets;
  const out = new Set<string>();
  for (const value of first) {
    if (rest.every((set) => set.has(value))) out.add(value);
  }
  return out;
}

function union(sets: Set<string>[]): Set<string> {
  const out = new Set<string>();
  for (const set of sets) {
    for (const value of set) out.add(value);
  }
  return out;
}
