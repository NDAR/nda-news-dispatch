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
}

export interface Template {
  id: string;
  version: number;
  title: string;
  subject: string;
  html: string;
  targetTags: string[];
  updatedAt: string;
  updatedBy?: string;
  deleted?: boolean;
}

export type CampaignStatus = 'draft' | 'scheduled' | 'queued' | 'sending' | 'sent' | 'failed';

export interface Campaign {
  id: string;
  name: string;
  templateId?: string;
  templateVersion?: number;
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
    opened?: number;
    clicked?: number;
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

// ── Contacts ────────────────────────────────────────────────────────────────

export const listContacts = (opts: { tag?: string; limit?: number; next?: string } = {}) => {
  const qs = new URLSearchParams();
  if (opts.tag) qs.set('tag', opts.tag);
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

// ── Suppressions ────────────────────────────────────────────────────────────

export const listSuppressions = () =>
  api<{ items: Array<{ email: string; reason: string; addedAt: string; source?: string }> }>(
    '/admin/suppressions',
  );
export const addSuppression = (input: { email: string; reason?: string; note?: string }) =>
  api<{ email: string; reason: string }>('/admin/suppressions', {
    method: 'POST',
    body: JSON.stringify(input),
  });
export const removeSuppression = (email: string) =>
  api<{ email: string; removed: number }>(
    `/admin/suppressions/${encodeURIComponent(email)}`,
    { method: 'DELETE' },
  );
