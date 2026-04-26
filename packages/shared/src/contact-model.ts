export type ContactStatus = 'active' | 'unsubscribed' | 'bounced';

export interface AudienceProfile {
  email: string;
  name: string;
  org?: string;
  tags: string[];
  status: ContactStatus;
  suppressed: boolean;
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
  return {
    email: String(item.email ?? ''),
    name: String(item.name ?? ''),
    org: typeof item.org === 'string' ? item.org : undefined,
    tags: Array.isArray(item.tags) ? item.tags.filter((t): t is string => typeof t === 'string') : [],
    status: normalizeContactStatus(item.status),
    suppressed: item.suppressed === true,
    suppressedAt: typeof item.suppressedAt === 'string' ? item.suppressedAt : undefined,
    suppressionReason:
      typeof item.suppressionReason === 'string' ? item.suppressionReason : undefined,
  };
}

function normalizeContactStatus(value: unknown): ContactStatus {
  return value === 'unsubscribed' || value === 'bounced' ? value : 'active';
}
