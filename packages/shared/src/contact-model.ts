export type ContactStatus = 'active' | 'unsubscribed' | 'bounced';

export interface AudienceProfile {
  email: string;
  name: string;
  org?: string;
  tags: string[];
  status: ContactStatus;
  /** Legacy flag — true if any suppression (global or per-type) exists. */
  suppressed: boolean;
  /** Hard suppression — blocks every send regardless of newsletter type. */
  suppressedGlobal: boolean;
  /** Per-type suppressions; non-empty means at least one type is opted out. */
  suppressedTypes: string[];
  suppressedAt?: string;
  suppressionReason?: string;
}

export function contactStatusIndexPk(status: ContactStatus): string {
  return `CONTACTSTATUS#${status}`;
}

export function contactStatusIndexSk(email: string): string {
  return `CONTACT#${email}`;
}

export function contactStatusIndexFields(email: string, status: ContactStatus): {
  GSI2PK: string;
  GSI2SK: string;
} {
  return {
    GSI2PK: contactStatusIndexPk(status),
    GSI2SK: contactStatusIndexSk(email),
  };
}

export function suppressionState(
  reason?: string,
  at?: string,
): {
  suppressed: boolean;
  suppressedAt?: string;
  suppressionReason?: string;
} {
  return reason
    ? { suppressed: true, suppressedAt: at, suppressionReason: reason }
    : { suppressed: false };
}

export function toAudienceProfile(item: Record<string, unknown>): AudienceProfile {
  const suppressedTypes = readStringSet(item.suppressedTypes);
  const suppressedGlobal = item.suppressedGlobal === true;
  // Legacy `suppressed` boolean predates the per-type model. If the new
  // denorm fields are missing (record not yet migrated), fall back to it as
  // a global signal so we still drop the recipient.
  const legacySuppressed = item.suppressed === true;
  const suppressed = suppressedGlobal || suppressedTypes.length > 0 || legacySuppressed;
  return {
    email: String(item.email ?? ''),
    name: String(item.name ?? ''),
    org: typeof item.org === 'string' ? item.org : undefined,
    tags: Array.isArray(item.tags) ? item.tags.filter((t): t is string => typeof t === 'string') : [],
    status: normalizeContactStatus(item.status),
    suppressed,
    suppressedGlobal: suppressedGlobal || (legacySuppressed && suppressedTypes.length === 0),
    suppressedTypes,
    suppressedAt: typeof item.suppressedAt === 'string' ? item.suppressedAt : undefined,
    suppressionReason:
      typeof item.suppressionReason === 'string' ? item.suppressionReason : undefined,
  };
}

function readStringSet(value: unknown): string[] {
  if (!value) return [];
  // DDB DocumentClient unmarshalls a String Set as a JS Set when the
  // wrapNumbers / convertEmptyValues defaults are kept; older clients return
  // the raw `{ values: string[] }` shape. Handle both, plus arrays.
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

function normalizeContactStatus(value: unknown): ContactStatus {
  return value === 'unsubscribed' || value === 'bounced' ? value : 'active';
}
