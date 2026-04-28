import { api } from './client';

// ── Types (mirror of packages/shared schemas) ───────────────────────────────

export type ContactStatus = 'active' | 'unsubscribed' | 'bounced';

export interface Contact {
  email: string;
  name: string;
  org?: string;
  tags: string[];
  status: ContactStatus;
  joined: string;
  updatedAt: string;
  /** Derived: true if any suppression (global or per-type) is in effect. */
  suppressed?: boolean;
  /** Hard suppression — blocks every send regardless of newsletter type. */
  suppressedGlobal?: boolean;
  /** Per-type opt-outs (newsletter typeIds the contact has unsubscribed from). */
  suppressedTypes?: string[];
}

export interface Template {
  id: string;
  version: number;
  title: string;
  subject: string;
  html: string;
  targetTags: string[];
  /** Required server-side; optional in TS so partials still typecheck. */
  typeId?: string;
  updatedAt: string;
  updatedBy?: string;
  deleted?: boolean;
}

export interface NewsletterType {
  id: string;
  name: string;
  description?: string;
  /** oklch hue 0..360 */
  color: number;
  defaultTags: string[];
  defaultSubjectPrefix?: string;
  /** Optional HTML body seeded into new newsletters created with this type. */
  defaultBodyHtml?: string;
  archived?: boolean;
  createdAt: string;
  createdBy?: string;
}

export type CampaignStatus = 'draft' | 'scheduled' | 'queued' | 'sending' | 'sent' | 'failed';

export interface Campaign {
  id: string;
  name: string;
  templateId?: string;
  templateVersion?: number;
  /** Denormalized from the template at create time. */
  typeId?: string;
  subject: string;
  html: string;
  status: CampaignStatus;
  recipients: number;
  tags: string[];
  excludeTags: string[];
  tagMode: 'all' | 'any';
  createdAt: string;
  createdBy?: string;
  sentAt?: string;
  scheduleAt?: string;
  stats?: {
    delivered?: number;
    /** Total Open events from SES (multi-device opens, prefetchers, scanners). */
    opened?: number;
    /** Distinct recipients who opened at least once. */
    uniqueOpened?: number;
    clicked?: number;
    /** Distinct recipients who clicked at least one link. */
    uniqueClicked?: number;
    bounced?: number;
    complained?: number;
    unsubscribed?: number;
  };
}

export interface ImportJob {
  importId: string;
  key: string;
  filename?: string;
  assignTag?: string;
  status: 'pending' | 'processing' | 'done' | 'failed';
  counts: { total: number; inserted: number; updated: number; suppressed: number; invalid: number };
  createdAt: string;
  createdBy?: string;
  error?: string;
}

// ── Ping ────────────────────────────────────────────────────────────────────

export const pingApi = () =>
  api<{ ok: true; env: string; at: string; user: { sub: string; email: string } }>(
    '/admin/ping',
  );

// ── Templates ───────────────────────────────────────────────────────────────

export const listTemplates = () => api<Template[]>('/admin/templates');
export const getTemplate = (id: string) => api<Template>(`/admin/templates/${id}`);
export const createTemplate = (t: Partial<Template>) =>
  api<Template>('/admin/templates', { method: 'POST', body: JSON.stringify(t) });
export const updateTemplate = (id: string, t: Partial<Template>) =>
  api<Template>(`/admin/templates/${id}`, { method: 'PUT', body: JSON.stringify(t) });
export const deleteTemplate = (id: string) =>
  api<{ id: string; deleted: true }>(`/admin/templates/${id}`, { method: 'DELETE' });
export const testSendTemplate = (id: string, to?: string) =>
  api<{ id: string; to: string; enqueued: 1 }>(
    `/admin/templates/${id}/test-send`,
    { method: 'POST', body: JSON.stringify(to ? { to } : {}) },
  );

// ── Newsletter types ────────────────────────────────────────────────────────

export const listTypes = (includeArchived = false) =>
  api<NewsletterType[]>(`/admin/types${includeArchived ? '?includeArchived=1' : ''}`);
export const getType = (id: string) => api<NewsletterType>(`/admin/types/${id}`);
export const createType = (t: Partial<NewsletterType>) =>
  api<NewsletterType>('/admin/types', { method: 'POST', body: JSON.stringify(t) });
export const updateType = (id: string, t: Partial<NewsletterType>) =>
  api<NewsletterType>(`/admin/types/${id}`, { method: 'PUT', body: JSON.stringify(t) });
export const archiveType = (id: string) =>
  api<{ id: string; archived: true }>(`/admin/types/${id}`, { method: 'DELETE' });

// ── Contacts ────────────────────────────────────────────────────────────────

export const listContacts = (
  opts: { tag?: string; status?: ContactStatus; limit?: number; next?: string } = {},
) => {
  const qs = new URLSearchParams();
  if (opts.tag) qs.set('tag', opts.tag);
  if (opts.status) qs.set('status', opts.status);
  if (opts.limit) qs.set('limit', String(opts.limit));
  if (opts.next) qs.set('next', opts.next);
  const s = qs.toString();
  return api<{ items: Contact[]; next?: string }>(`/admin/contacts${s ? `?${s}` : ''}`);
};
export const getContact = (email: string) =>
  api<Contact>(`/admin/contacts/${encodeURIComponent(email)}`);
export const upsertContact = (c: Partial<Contact>) =>
  api<Contact>('/admin/contacts', { method: 'POST', body: JSON.stringify(c) });
export const patchContact = (email: string, c: Partial<Contact>) =>
  api<Contact>(`/admin/contacts/${encodeURIComponent(email)}`, {
    method: 'PATCH',
    body: JSON.stringify(c),
  });
export const deleteContact = (email: string) =>
  api<{ email: string; deleted: true }>(`/admin/contacts/${encodeURIComponent(email)}`, {
    method: 'DELETE',
  });

// ── Imports ─────────────────────────────────────────────────────────────────

export const createImport = (input: { filename?: string; assignTags?: string[] } = {}) =>
  api<{ importId: string; uploadUrl: string; key: string; expiresIn: number }>(
    '/admin/imports',
    { method: 'POST', body: JSON.stringify(input) },
  );
export const listImports = () => api<{ items: ImportJob[] }>('/admin/imports');
export const getImport = (id: string) => api<ImportJob>(`/admin/imports/${id}`);

export async function uploadCsv(uploadUrl: string, file: File | Blob | string): Promise<void> {
  const body = typeof file === 'string' ? file : file;
  const res = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': 'text/csv' },
    body,
  });
  if (!res.ok) throw new Error(`CSV upload failed: ${res.status}`);
}

// ── Campaigns ───────────────────────────────────────────────────────────────

export const listCampaigns = (status?: CampaignStatus) => {
  const qs = status ? `?status=${status}` : '';
  return api<{ items: Campaign[] }>(`/admin/campaigns${qs}`);
};
export const getCampaign = (id: string) => api<Campaign>(`/admin/campaigns/${id}`);
export const createCampaign = (c: Partial<Campaign>) =>
  api<Campaign>('/admin/campaigns', { method: 'POST', body: JSON.stringify(c) });
export const deleteCampaign = (id: string) =>
  api<{ id: string; deleted: true }>(`/admin/campaigns/${id}`, { method: 'DELETE' });
export const sendCampaign = (
  id: string,
  input: {
    tagMode?: 'all' | 'any';
    tags?: string[];
    excludeTags?: string[];
    testOnly?: boolean;
    /** ISO-8601 UTC timestamp; if present, schedule the send instead of dispatching now. */
    scheduleAt?: string;
  },
) => api<{ id: string; status: string; enqueued: number; scheduleAt?: string }>(
  `/admin/campaigns/${id}/send`,
  { method: 'POST', body: JSON.stringify(input) },
);

export const cancelScheduledCampaign = (id: string) =>
  api<{ id: string; status: 'draft' }>(
    `/admin/campaigns/${id}/cancel`,
    { method: 'POST' },
  );

export interface CampaignRecipient {
  email: string;
  state?: string;
  queuedAt?: string;
  deliveredAt?: string;
  openedAt?: string;
  clickedAt?: string;
  lastClickUrl?: string;
  bouncedAt?: string;
  bounceType?: string;
  complainedAt?: string;
  rejectedAt?: string;
  failedAt?: string;
  lastDelayAt?: string;
  messageId?: string;
}

export const listCampaignRecipients = (id: string) =>
  api<{ items: CampaignRecipient[]; truncated: boolean }>(
    `/admin/campaigns/${id}/recipients`,
  );

export interface CampaignLink {
  url: string;
  clicks: number;
  uniqueClicks: number;
  firstSeenAt?: string;
  lastSeenAt?: string;
}

export const listCampaignLinks = (id: string) =>
  api<{ items: CampaignLink[] }>(`/admin/campaigns/${id}/links`);

// ── Assets (newsletter images) ──────────────────────────────────────────────

export interface Asset {
  id: string;
  filename: string;
  contentType: string;
  size?: number;
  key: string;
  url: string;
  createdAt: string;
  createdBy?: string;
}

export const listAssets = () => api<{ items: Asset[] }>('/admin/assets');

export const createAsset = (input: { filename: string; contentType: string; size?: number }) =>
  api<{
    id: string;
    uploadUrl: string;
    url: string;
    key: string;
    expiresIn: number;
    contentType: string;
  }>('/admin/assets', { method: 'POST', body: JSON.stringify(input) });

export const deleteAsset = (id: string) =>
  api<{ id: string; deleted: true }>(`/admin/assets/${id}`, { method: 'DELETE' });

/** Direct PUT to the presigned URL — bypasses the api() wrapper because the
 *  request goes straight to S3 with no auth header. */
export async function uploadAsset(uploadUrl: string, file: File): Promise<void> {
  const res = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': file.type },
    body: file,
  });
  if (!res.ok) throw new Error(`Asset upload failed: ${res.status}`);
}

// ── Audience (tags + preview) ───────────────────────────────────────────────

export interface TagInfo {
  tag: string;
  count: number;
}

export const listTags = () => api<{ items: TagInfo[] }>('/admin/tags');

export interface AudiencePreview {
  count: number;
  total: number;
  topTags: { tag: string; count: number }[];
  sample: { email: string; name: string; org?: string }[];
}

export const previewAudience = (input: {
  tags?: string[];
  excludeTags?: string[];
  tagMode?: 'all' | 'any';
}) =>
  api<AudiencePreview>('/admin/audience/preview', {
    method: 'POST',
    body: JSON.stringify(input),
  });

// ── Settings (org-level singleton) ──────────────────────────────────────────

export interface OrgSettings {
  footerHtml: string;
  senderName?: string;
  senderAddress?: string;
  updatedAt?: string;
  updatedBy?: string;
}

export const getSettings = () => api<OrgSettings>('/admin/settings');
export const updateSettings = (s: Partial<OrgSettings>) =>
  api<OrgSettings>('/admin/settings', { method: 'PUT', body: JSON.stringify(s) });

// ── Suppressions ────────────────────────────────────────────────────────────

export type SuppressionScope = 'global' | 'type';

export interface Suppression {
  email: string;
  /** Real DDB sort key for this row. Pass back on DELETE so the server can
   *  delete this exact row even if it's a legacy `REASON#…` shape. */
  sk: string;
  scope: SuppressionScope;
  /** Newsletter type id when scope is "type". */
  typeId?: string;
  /** Display name of the newsletter type, when the API can resolve it. */
  typeName?: string;
  reason: string;
  addedAt: string;
  source?: string;
  campaignId?: string;
  note?: string;
  addedBy?: string;
  messageId?: string;
}

export const listSuppressions = (
  opts: { scope?: SuppressionScope; typeId?: string; limit?: number } = {},
) => {
  const qs = new URLSearchParams();
  if (opts.scope) qs.set('scope', opts.scope);
  if (opts.typeId) qs.set('typeId', opts.typeId);
  if (opts.limit) qs.set('limit', String(opts.limit));
  const s = qs.toString();
  return api<{ items: Suppression[] }>(`/admin/suppressions${s ? `?${s}` : ''}`);
};

export const addSuppression = (
  input: {
    email: string;
    scope?: SuppressionScope;
    typeId?: string;
    reason?: string;
    note?: string;
  },
) =>
  api<{ email: string; scope: SuppressionScope; typeId?: string; reason: string }>(
    '/admin/suppressions',
    { method: 'POST', body: JSON.stringify(input) },
  );

/** Removes a scoped suppression row.
 *
 * Prefer passing the full `sk` from the listed Suppression — it lets the
 * server delete the exact row, including legacy `REASON#…` shapes, instead
 * of computing a canonical SK from the scope (which would silently no-op
 * on legacy rows). With no `sk` and no scope, removes every SUPP row for
 * the email. */
export const removeSuppression = (
  email: string,
  opts: { sk?: string; scope?: SuppressionScope | 'all'; typeId?: string } = {},
) => {
  const qs = new URLSearchParams();
  if (opts.sk) qs.set('sk', opts.sk);
  if (opts.scope) qs.set('scope', opts.scope);
  if (opts.typeId) qs.set('typeId', opts.typeId);
  const s = qs.toString();
  return api<{ email: string; removed: number }>(
    `/admin/suppressions/${encodeURIComponent(email)}${s ? `?${s}` : ''}`,
    { method: 'DELETE' },
  );
};
