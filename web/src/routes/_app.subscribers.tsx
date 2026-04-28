import { createFileRoute } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import {
  createImport,
  deleteContact,
  getImport,
  listContacts,
  listSuppressions,
  listTags,
  listTypes,
  patchContact,
  removeSuppression,
  upsertContact,
  uploadCsv,
  type Contact,
  type NewsletterType,
  type Suppression,
  type SuppressionScope,
} from '../api/endpoints';

export const Route = createFileRoute('/_app/subscribers')({
  component: SubscribersPage,
});

type View = 'subscribers' | 'suppressions';

function SubscribersPage() {
  const qc = useQueryClient();
  const [view, setView] = useState<View>('subscribers');
  const [tagFilter, setTagFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<'' | 'active' | 'unsubscribed' | 'bounced'>('');
  const { data, isLoading, error } = useQuery({
    queryKey: ['contacts', tagFilter, statusFilter],
    queryFn: () =>
      listContacts({
        ...(tagFilter ? { tag: tagFilter } : {}),
        ...(statusFilter ? { status: statusFilter } : {}),
        limit: 200,
      }),
  });

  // Tag universe for the upload modal's chip picker. Same source as the
  // Send page so users see consistent tag suggestions across screens.
  const { data: tagsResp, isLoading: tagsLoading } = useQuery({
    queryKey: ['admin-tags'],
    queryFn: listTags,
  });
  const knownTags = (tagsResp?.items ?? []).map((t) => t.tag);

  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [importId, setImportId] = useState<string | null>(null);
  const [uploadStatus, setUploadStatus] = useState<string>('');
  const [addOpen, setAddOpen] = useState(false);

  const addMut = useMutation({
    mutationFn: (input: { email: string; name: string; org?: string; tags: string[] }) =>
      upsertContact(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['contacts'] });
      qc.invalidateQueries({ queryKey: ['admin-tags'] });
      setAddOpen(false);
    },
  });

  // Suppression list — split into two views. "global" is the hard list
  // (bounces, complaints, operator stop-everything). "type" lists per-newsletter
  // opt-outs the SES feedback loop and unsubscribe link wrote there.
  const [suppressionScope, setSuppressionScope] = useState<SuppressionScope>('global');
  const [suppressionTypeId, setSuppressionTypeId] = useState<string>('');
  const suppressionsQ = useQuery({
    queryKey: ['suppressions', suppressionScope, suppressionTypeId],
    queryFn: () =>
      listSuppressions({
        scope: suppressionScope,
        typeId: suppressionScope === 'type' && suppressionTypeId ? suppressionTypeId : undefined,
      }),
    enabled: view === 'suppressions',
  });

  // Newsletter types power the type picker + per-row badges.
  const typesQ = useQuery({
    queryKey: ['types'],
    queryFn: () => listTypes(),
    enabled: view === 'suppressions',
  });

  const removeSuppMut = useMutation({
    mutationFn: ({
      email,
      sk,
      scope,
      typeId,
    }: {
      email: string;
      sk?: string;
      scope: SuppressionScope | 'all';
      typeId?: string;
    }) => removeSuppression(email, { sk, scope, typeId }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['suppressions'] }),
  });

  // Per-row tag edits — `variables.email` lets multiple in-flight edits coexist
  // without one row's pending state masking another's. We optimistically patch
  // the cached contact list so the pill update feels instant; on error we
  // invalidate to fall back to the server state.
  const tagsMut = useMutation({
    mutationFn: ({ email, tags }: { email: string; tags: string[] }) =>
      patchContact(email, { tags }),
    onMutate: async ({ email, tags }) => {
      await qc.cancelQueries({ queryKey: ['contacts'] });
      const prev = qc.getQueriesData<{ items: Contact[]; next?: string }>({ queryKey: ['contacts'] });
      qc.setQueriesData<{ items: Contact[]; next?: string }>({ queryKey: ['contacts'] }, (old) => {
        if (!old) return old;
        return { ...old, items: old.items.map((c) => (c.email === email ? { ...c, tags } : c)) };
      });
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      ctx?.prev?.forEach(([key, value]) => qc.setQueryData(key, value));
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['contacts'] });
      qc.invalidateQueries({ queryKey: ['admin-tags'] });
    },
  });

  const importQuery = useQuery({
    queryKey: ['import', importId],
    queryFn: () => (importId ? getImport(importId) : Promise.resolve(null)),
    enabled: !!importId,
    refetchInterval: (q) => {
      const d = q.state.data;
      if (!d || d.status === 'pending' || d.status === 'processing') return 2000;
      return false;
    },
  });

  const onUpload = async (file: File, assignTags: string[]) => {
    setUploading(true);
    setUploadStatus('Requesting upload URL…');
    try {
      const { importId: id, uploadUrl } = await createImport({
        filename: file.name,
        assignTags,
      });
      setUploadStatus('Uploading…');
      await uploadCsv(uploadUrl, file);
      setUploadStatus('Processing (worker polling)…');
      setImportId(id);
      qc.invalidateQueries({ queryKey: ['contacts'] });
      qc.invalidateQueries({ queryKey: ['admin-tags'] });
      setUploadOpen(false);
    } catch (e) {
      setUploadStatus(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setUploading(false);
    }
  };

  const deleteMut = useMutation({
    mutationFn: (email: string) => deleteContact(email),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['contacts'] }),
  });

  const importStatus = importQuery.data?.status;
  useEffect(() => {
    if (importStatus === 'done' || importStatus === 'failed') {
      qc.invalidateQueries({ queryKey: ['contacts'] });
      qc.invalidateQueries({ queryKey: ['admin-tags'] });
    }
  }, [importStatus, qc]);

  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="card">
        <div className="card-header">
          <div className="row items-center gap-md">
            <div>
              <div className="eyebrow">Audience</div>
              <h3 className="serif mt-sm">
                {view === 'subscribers' ? 'Subscribers' : 'Suppression list'}
              </h3>
            </div>
            <div className="segmented">
              <button
                className={view === 'subscribers' ? 'active' : ''}
                onClick={() => setView('subscribers')}
              >
                Subscribers
              </button>
              <button
                className={view === 'suppressions' ? 'active' : ''}
                onClick={() => setView('suppressions')}
              >
                Suppression list
              </button>
            </div>
          </div>
          {view === 'subscribers' && (
            <div className="row items-center gap-sm">
              <select
                className="select"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
                style={{ width: 160 }}
                title="Filter by subscription status"
              >
                <option value="">All statuses</option>
                <option value="active">Active</option>
                <option value="unsubscribed">Unsubscribed</option>
                <option value="bounced">Bounced</option>
              </select>
              <select
                className="select"
                value={tagFilter}
                onChange={(e) => setTagFilter(e.target.value)}
                style={{ width: 200 }}
                disabled={tagsLoading}
              >
                <option value="">All tags</option>
                {knownTags.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
              <button
                className="btn btn-sm"
                onClick={() => setAddOpen(true)}
              >
                + Add subscriber
              </button>
              <button
                className="btn btn-accent btn-sm"
                onClick={() => setUploadOpen(true)}
                disabled={uploading}
              >
                Upload CSV
              </button>
            </div>
          )}
        </div>
        <div className="card-body">
          {view === 'suppressions' && (
            <SuppressionsPanel
              query={suppressionsQ}
              types={typesQ.data ?? []}
              scope={suppressionScope}
              onScopeChange={setSuppressionScope}
              typeFilter={suppressionTypeId}
              onTypeFilterChange={setSuppressionTypeId}
              onRemove={(s) => {
                const target =
                  s.scope === 'type'
                    ? `${s.email} from "${s.typeName ?? s.typeId ?? 'this newsletter'}"`
                    : `${s.email} from the global suppression list`;
                if (
                  confirm(
                    `Remove ${target}?\n\n` +
                      (s.scope === 'global'
                        ? 'This will allow every newsletter to send to this address again. Only do this if the bounce/complaint/manual entry was a mistake.'
                        : 'This will allow this specific newsletter type to send to the address again. Other types are unaffected.'),
                  )
                ) {
                  removeSuppMut.mutate({
                    email: s.email,
                    sk: s.sk,
                    scope: s.scope,
                    typeId: s.typeId,
                  });
                }
              }}
              removingKey={
                removeSuppMut.isPending && removeSuppMut.variables
                  ? `${removeSuppMut.variables.email}|${removeSuppMut.variables.sk ?? ''}`
                  : undefined
              }
            />
          )}
          {view === 'subscribers' && (uploadStatus || importQuery.data) && (
            <div
              style={{
                padding: 12,
                borderRadius: 6,
                background: 'var(--paper-deep)',
                border: '1px solid var(--rule-soft)',
                marginBottom: 14,
                fontSize: 12.5,
              }}
            >
              {importQuery.data ? (
                <>
                  <strong>Import {importQuery.data.status}</strong>
                  {' · '}
                  {importQuery.data.counts.total} rows —{' '}
                  {importQuery.data.counts.inserted} new,{' '}
                  {importQuery.data.counts.updated} updated,{' '}
                  {importQuery.data.counts.suppressed} suppressed,{' '}
                  {importQuery.data.counts.invalid} invalid
                  {importQuery.data.error && (
                    <div style={{ color: 'var(--bad)', marginTop: 4 }}>{importQuery.data.error}</div>
                  )}
                </>
              ) : (
                <span className="muted">{uploadStatus}</span>
              )}
            </div>
          )}

          {view === 'subscribers' && isLoading && <p className="muted">Loading subscribers…</p>}
          {view === 'subscribers' && error && (
            <p style={{ color: 'var(--bad)' }}>Failed to load contacts: {(error as Error).message}</p>
          )}
          {view === 'subscribers' && data && (
            <>
              <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
                Showing {data.items.length} subscriber{data.items.length === 1 ? '' : 's'}
                {statusFilter && ` · ${statusFilter}`}
                {tagFilter && ` · tag "${tagFilter}"`}
              </div>
              <table className="table">
                <thead>
                  <tr>
                    <th>Email</th>
                    <th>Name</th>
                    <th>Org</th>
                    <th>Tags</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((c) => (
                    <tr key={c.email}>
                      <td className="mono-sm">{c.email}</td>
                      <td>{c.name}</td>
                      <td>{c.org ?? '—'}</td>
                      <td>
                        <TagsCell
                          contact={c}
                          knownTags={knownTags}
                          onChange={(tags) => tagsMut.mutate({ email: c.email, tags })}
                          pending={tagsMut.isPending && tagsMut.variables?.email === c.email}
                        />
                      </td>
                      <td>
                        <span
                          className={`pill ${
                            c.status === 'active'
                              ? 'sent'
                              : c.status === 'bounced'
                                ? 'failed'
                                : 'draft'
                          }`}
                        >
                          {c.status}
                        </span>
                      </td>
                      <td className="text-right">
                        <button
                          className="btn btn-sm btn-ghost"
                          onClick={() => {
                            if (confirm(`Delete ${c.email}?`)) deleteMut.mutate(c.email);
                          }}
                          disabled={deleteMut.isPending}
                          style={{ color: 'var(--bad)' }}
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))}
                  {data.items.length === 0 && (
                    <tr>
                      <td colSpan={6} className="muted text-center" style={{ padding: 24 }}>
                        No subscribers — upload a CSV to get started.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </>
          )}
        </div>
      </div>

      {uploadOpen && (
        <UploadCsvModal
          knownTags={knownTags}
          tagsLoading={tagsLoading}
          uploading={uploading}
          uploadStatus={uploadStatus}
          onClose={() => {
            if (!uploading) setUploadOpen(false);
          }}
          onUpload={onUpload}
        />
      )}

      {addOpen && (
        <AddSubscriberModal
          knownTags={knownTags}
          tagsLoading={tagsLoading}
          submitting={addMut.isPending}
          error={addMut.error as Error | undefined}
          onClose={() => {
            if (!addMut.isPending) {
              setAddOpen(false);
              addMut.reset();
            }
          }}
          onSubmit={(input) => addMut.mutate(input)}
        />
      )}
    </div>
  );
}

// ── Suppressions panel ─────────────────────────────────────────────────────

function SuppressionsPanel({
  query,
  types,
  scope,
  onScopeChange,
  typeFilter,
  onTypeFilterChange,
  onRemove,
  removingKey,
}: {
  query: { isLoading: boolean; error: unknown; data?: { items: Suppression[] } };
  types: NewsletterType[];
  scope: SuppressionScope;
  onScopeChange: (s: SuppressionScope) => void;
  typeFilter: string;
  onTypeFilterChange: (id: string) => void;
  onRemove: (s: Suppression) => void;
  removingKey: string | undefined;
}) {
  const items = query.data?.items ?? [];
  const visibleTypes = types.filter((t) => !t.archived);

  return (
    <>
      <div
        className="row items-center gap-md"
        style={{ marginBottom: 12, flexWrap: 'wrap' }}
      >
        <div className="segmented">
          <button
            className={scope === 'global' ? 'active' : ''}
            onClick={() => onScopeChange('global')}
            title="Bounces, complaints, and stop-everything opt-outs"
          >
            Global
          </button>
          <button
            className={scope === 'type' ? 'active' : ''}
            onClick={() => onScopeChange('type')}
            title="Per-newsletter unsubscribes"
          >
            By newsletter type
          </button>
        </div>
        {scope === 'type' && (
          <select
            className="select"
            value={typeFilter}
            onChange={(e) => onTypeFilterChange(e.target.value)}
          >
            <option value="">All newsletter types</option>
            {visibleTypes.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        )}
      </div>

      {query.isLoading && <p className="muted">Loading suppression list…</p>}
      {query.error && (
        <p style={{ color: 'var(--bad)' }}>
          Failed to load suppressions: {(query.error as Error).message}
        </p>
      )}

      {!query.isLoading && !query.error && (
        <>
          <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
            {items.length === 0 ? (
              scope === 'global'
                ? 'No global suppressions. Hard bounces, complaints, and operator opt-outs will appear here automatically.'
                : typeFilter
                  ? 'Nobody has unsubscribed from this newsletter type.'
                  : 'No per-newsletter unsubscribes on file.'
            ) : (
              `${items.length} ${scope === 'global' ? 'address' : 'unsubscribe'}${items.length === 1 ? '' : 'es'} on file.`
            )}
          </div>
          {items.length > 0 && (
            <table className="table">
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Reason</th>
                  {scope === 'type' && <th>Newsletter</th>}
                  <th>Source</th>
                  <th>Added</th>
                  <th>Note</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {items.map((s) => {
                  const rowKey = `${s.email}|${s.sk}`;
                  return (
                    <tr key={rowKey}>
                      <td className="mono-sm">{s.email}</td>
                      <td>
                        <SuppressionReasonPill reason={s.reason} />
                      </td>
                      {scope === 'type' && (
                        <td className="muted" style={{ fontSize: 12 }}>
                          {s.typeName ?? s.typeId ?? '—'}
                        </td>
                      )}
                      <td className="muted" style={{ fontSize: 12 }}>{s.source ?? '—'}</td>
                      <td className="muted mono-sm" style={{ fontSize: 11 }}>
                        {s.addedAt ? new Date(s.addedAt).toLocaleString() : '—'}
                      </td>
                      <td className="muted" style={{ fontSize: 12 }}>
                        {s.note || (s.addedBy ? <span className="faint">by {s.addedBy}</span> : '—')}
                      </td>
                      <td className="text-right">
                        <button
                          className="btn btn-sm btn-ghost"
                          onClick={() => onRemove(s)}
                          disabled={removingKey === rowKey}
                          style={{ color: 'var(--bad)' }}
                          title={
                            s.scope === 'global'
                              ? 'Remove from the global suppression list'
                              : 'Remove this per-newsletter opt-out'
                          }
                        >
                          {removingKey === rowKey ? 'Removing…' : 'Remove'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </>
      )}
    </>
  );
}

function SuppressionReasonPill({ reason }: { reason: string }) {
  const cls =
    reason === 'bounce' ? 'failed' : reason === 'complaint' ? 'failed' : 'draft';
  return <span className={`pill ${cls}`}>{reason}</span>;
}

// ── Inline tags editor ─────────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TAG_NORMALIZE_RE = /[^a-z0-9-]/g;

function normalizeTag(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(TAG_NORMALIZE_RE, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * In-cell tag editor. Pills are clickable to remove (× appears on hover); the
 * "+" button opens a small popover anchored under the cell with unselected
 * known tags + a custom-tag input. All mutations call back through `onChange`
 * with the full new tag array so the parent can patch the contact in one shot.
 */
function TagsCell({
  contact,
  knownTags,
  onChange,
  pending,
}: {
  contact: Contact;
  knownTags: string[];
  onChange: (tags: string[]) => void;
  pending: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const wrapRef = useRef<HTMLDivElement>(null);

  // Close the popover on outside click. Esc handled inline on the input.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onDoc);
    return () => window.removeEventListener('mousedown', onDoc);
  }, [open]);

  const removeTag = (t: string) => onChange(contact.tags.filter((x) => x !== t));
  const addTag = (raw: string) => {
    const t = normalizeTag(raw);
    if (!t || contact.tags.includes(t)) return;
    onChange([...contact.tags, t]);
    setDraft('');
  };

  const unselected = knownTags.filter((t) => !contact.tags.includes(t));

  return (
    <div ref={wrapRef} style={{ position: 'relative', display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
      {contact.tags.length === 0 && !open && (
        <span className="faint" style={{ fontSize: 11 }}>—</span>
      )}
      {contact.tags.map((t) => (
        <button
          key={t}
          onClick={() => removeTag(t)}
          disabled={pending}
          title="Click to remove"
          className="pill"
          style={{
            cursor: pending ? 'wait' : 'pointer',
            border: '1px solid var(--rule)',
            background: 'var(--paper-deep)',
            color: 'var(--ink-soft)',
            fontFamily: 'var(--sans)',
            fontSize: 11,
          }}
        >
          {t} <span style={{ marginLeft: 2, opacity: 0.6 }}>×</span>
        </button>
      ))}
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={pending}
        title="Add tag"
        style={{
          border: '1px dashed var(--rule)',
          background: 'transparent',
          color: 'var(--ink-mute)',
          borderRadius: 99,
          padding: '2px 8px',
          fontSize: 11,
          fontFamily: 'var(--sans)',
          cursor: pending ? 'wait' : 'pointer',
        }}
      >
        + Tag
      </button>
      {open && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            marginTop: 4,
            minWidth: 220,
            maxWidth: 320,
            zIndex: 10,
            background: 'var(--paper)',
            border: '1px solid var(--rule)',
            borderRadius: 6,
            boxShadow: '0 4px 12px oklch(0.15 0 0 / 0.08)',
            padding: 10,
          }}
        >
          {unselected.length > 0 && (
            <div className="row items-center" style={{ gap: 4, flexWrap: 'wrap', marginBottom: 8 }}>
              {unselected.map((t) => (
                <button
                  key={t}
                  onClick={() => {
                    addTag(t);
                    setOpen(false);
                  }}
                  style={{
                    background: 'var(--paper)',
                    color: 'var(--ink-soft)',
                    border: '1px solid var(--rule)',
                    borderRadius: 99,
                    padding: '3px 9px',
                    fontSize: 11,
                    fontFamily: 'var(--sans)',
                    cursor: 'pointer',
                  }}
                >
                  + {t}
                </button>
              ))}
            </div>
          )}
          <div className="row items-center gap-sm">
            <input
              className="input"
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addTag(draft);
                  setOpen(false);
                } else if (e.key === 'Escape') {
                  setOpen(false);
                }
              }}
              placeholder="New tag…"
              style={{ flex: 1, fontSize: 12, padding: '5px 8px' }}
            />
            <button
              className="btn btn-sm"
              disabled={!draft.trim()}
              onClick={() => {
                addTag(draft);
                setOpen(false);
              }}
            >
              Add
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Add subscriber modal ───────────────────────────────────────────────────

function AddSubscriberModal({
  knownTags,
  tagsLoading,
  submitting,
  error,
  onClose,
  onSubmit,
}: {
  knownTags: string[];
  tagsLoading: boolean;
  submitting: boolean;
  error?: Error;
  onClose: () => void;
  onSubmit: (input: { email: string; name: string; org?: string; tags: string[] }) => void;
}) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [org, setOrg] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [draftTag, setDraftTag] = useState('');
  const [emailError, setEmailError] = useState<string | null>(null);

  // Esc to close — matches the rest of the app's modal behavior.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [submitting, onClose]);

  const toggleTag = (t: string) => {
    setTags(tags.includes(t) ? tags.filter((x) => x !== t) : [...tags, t]);
  };
  const addCustomTag = () => {
    const t = draftTag
      .trim()
      .toLowerCase()
      .replace(TAG_NORMALIZE_RE, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    if (!t) return;
    if (!tags.includes(t)) setTags([...tags, t]);
    setDraftTag('');
  };

  const submit = () => {
    const cleanEmail = email.trim().toLowerCase();
    if (!EMAIL_RE.test(cleanEmail)) {
      setEmailError('Enter a valid email address.');
      return;
    }
    setEmailError(null);
    onSubmit({
      email: cleanEmail,
      // Default the display name to the address's local part — matches what
      // the CSV importer does when the name column is empty.
      name: name.trim() || cleanEmail.split('@')[0],
      org: org.trim() || undefined,
      tags,
    });
  };

  const unselected = knownTags.filter((t) => !tags.includes(t));

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 480 }}>
        <div className="modal-header">
          <div>
            <div className="eyebrow">Audience</div>
            <h3 className="serif mt-sm">Add subscriber</h3>
          </div>
        </div>
        <div className="modal-body stack" style={{ gap: 14 }}>
          <div>
            <div className="label">Email</div>
            <input
              className="input"
              type="email"
              autoFocus
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                if (emailError) setEmailError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit();
              }}
              placeholder="person@example.org"
              style={{ fontFamily: 'var(--mono)', fontSize: 13, padding: '8px 10px' }}
            />
            {emailError && (
              <div style={{ color: 'var(--bad)', fontSize: 11, marginTop: 4 }}>{emailError}</div>
            )}
          </div>
          <div>
            <div className="label">Name (optional)</div>
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Defaults to the email's local part"
              style={{ fontFamily: 'var(--serif)', fontSize: 14, padding: '8px 10px' }}
            />
          </div>
          <div>
            <div className="label">Organization (optional)</div>
            <input
              className="input"
              value={org}
              onChange={(e) => setOrg(e.target.value)}
              style={{ fontSize: 13, padding: '8px 10px' }}
            />
          </div>
          <div>
            <div className="label">Tags</div>
            <div className="stack" style={{ gap: 8 }}>
              {tags.length > 0 && (
                <div className="row items-center" style={{ gap: 6, flexWrap: 'wrap' }}>
                  {tags.map((t) => (
                    <button
                      key={t}
                      onClick={() => toggleTag(t)}
                      title="Click to remove"
                      style={{
                        background: 'var(--ink)',
                        color: 'var(--paper)',
                        border: 'none',
                        borderRadius: 99,
                        padding: '3px 9px',
                        fontSize: 11,
                        fontFamily: 'var(--sans)',
                        cursor: 'pointer',
                      }}
                    >
                      {t} ×
                    </button>
                  ))}
                </div>
              )}
              {!tagsLoading && unselected.length > 0 && (
                <div className="row items-center" style={{ gap: 6, flexWrap: 'wrap' }}>
                  {unselected.map((t) => (
                    <button
                      key={t}
                      onClick={() => toggleTag(t)}
                      style={{
                        background: 'var(--paper)',
                        color: 'var(--ink-soft)',
                        border: '1px solid var(--rule)',
                        borderRadius: 99,
                        padding: '3px 9px',
                        fontSize: 11,
                        fontFamily: 'var(--sans)',
                        cursor: 'pointer',
                      }}
                    >
                      + {t}
                    </button>
                  ))}
                </div>
              )}
              <div className="row items-center gap-sm">
                <input
                  className="input"
                  value={draftTag}
                  onChange={(e) => setDraftTag(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      addCustomTag();
                    }
                  }}
                  placeholder="Add custom tag…"
                  style={{ flex: 1, fontSize: 12, padding: '6px 10px' }}
                />
                <button
                  className="btn btn-sm"
                  onClick={addCustomTag}
                  disabled={!draftTag.trim()}
                >
                  Add
                </button>
              </div>
            </div>
          </div>
          {error && (
            <div style={{ color: 'var(--bad)', fontSize: 12 }}>
              Failed to save: {error.message}
            </div>
          )}
        </div>
        <div className="modal-footer" style={{ justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn btn-sm" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button
            className="btn btn-sm btn-primary"
            onClick={submit}
            disabled={submitting || !email.trim()}
          >
            {submitting ? 'Saving…' : 'Save subscriber'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Upload modal ────────────────────────────────────────────────────────────

function UploadCsvModal({
  knownTags,
  tagsLoading,
  uploading,
  uploadStatus,
  onClose,
  onUpload,
}: {
  knownTags: string[];
  tagsLoading: boolean;
  uploading: boolean;
  uploadStatus: string;
  onClose: () => void;
  onUpload: (file: File, tags: string[]) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [tags, setTags] = useState<string[]>([]);
  const [draftTag, setDraftTag] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const toggleTag = (t: string) => {
    setTags(tags.includes(t) ? tags.filter((x) => x !== t) : [...tags, t]);
  };
  const addCustomTag = () => {
    const t = draftTag
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    if (!t) return;
    if (!tags.includes(t)) setTags([...tags, t]);
    setDraftTag('');
  };

  const acceptFile = (f: File | null | undefined) => {
    if (!f) return;
    if (!/\.csv$/i.test(f.name) && f.type !== 'text/csv' && f.type !== 'application/vnd.ms-excel') {
      setFileError('Please choose a .csv file.');
      return;
    }
    setFileError(null);
    setFile(f);
  };

  const unselectedTags = knownTags.filter((t) => !tags.includes(t));

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-lg" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <div className="eyebrow">Import</div>
            <h3 className="serif mt-sm">Upload subscribers</h3>
          </div>
        </div>
        <div className="modal-body stack" style={{ gap: 18 }}>
          <div
            onDragEnter={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={(e) => {
              // Only clear when leaving the drop-zone itself, not its children.
              if (e.currentTarget === e.target) setDragOver(false);
            }}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              acceptFile(e.dataTransfer.files?.[0]);
            }}
            onClick={() => inputRef.current?.click()}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                inputRef.current?.click();
              }
            }}
            style={{
              border: `2px dashed ${dragOver ? 'var(--accent)' : 'var(--rule)'}`,
              borderRadius: 8,
              padding: '32px 20px',
              textAlign: 'center',
              cursor: 'pointer',
              background: dragOver
                ? 'oklch(from var(--accent) l c h / 0.06)'
                : 'var(--paper-deep)',
              transition: 'all 0.12s',
            }}
          >
            <input
              ref={inputRef}
              type="file"
              accept=".csv,text/csv"
              hidden
              onChange={(e) => {
                acceptFile(e.target.files?.[0]);
                e.currentTarget.value = '';
              }}
            />
            {file ? (
              <div>
                <div className="serif" style={{ fontSize: 15 }}>
                  📄 {file.name}{' '}
                  <span className="muted mono-sm">({(file.size / 1024).toFixed(1)} KB)</span>
                </div>
                <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
                  Click or drop another file to replace
                </div>
              </div>
            ) : (
              <>
                <div className="serif" style={{ fontSize: 16 }}>
                  Drop a CSV file here
                </div>
                <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                  or{' '}
                  <span style={{ color: 'var(--accent-deep)', textDecoration: 'underline' }}>
                    click to browse
                  </span>
                </div>
                <div className="faint" style={{ fontSize: 11, marginTop: 10 }}>
                  Expected columns: <code>email</code>, <code>name</code>, <code>org</code> (header
                  row required)
                </div>
              </>
            )}
          </div>
          {fileError && (
            <div style={{ color: 'var(--bad)', fontSize: 12 }}>{fileError}</div>
          )}

          <div>
            <div className="label">Apply tags to all subscribers in this CSV</div>
            <div className="muted" style={{ fontSize: 11.5, marginBottom: 10 }}>
              Optional. Tags help you target this group in the Send screen.
            </div>
            <div className="stack" style={{ gap: 8 }}>
              {tags.length > 0 && (
                <div className="row items-center" style={{ gap: 6, flexWrap: 'wrap' }}>
                  {tags.map((t) => (
                    <button
                      key={t}
                      onClick={() => toggleTag(t)}
                      title="Click to remove"
                      style={{
                        background: 'var(--ink)',
                        color: 'var(--paper)',
                        border: 'none',
                        borderRadius: 99,
                        padding: '4px 10px',
                        fontSize: 11.5,
                        fontFamily: 'var(--sans)',
                        cursor: 'pointer',
                      }}
                    >
                      {t} ×
                    </button>
                  ))}
                </div>
              )}
              <div className="row items-center" style={{ gap: 6, flexWrap: 'wrap' }}>
                {tagsLoading && (
                  <span className="muted" style={{ fontSize: 12 }}>
                    Loading existing tags…
                  </span>
                )}
                {!tagsLoading && unselectedTags.length === 0 && knownTags.length === 0 && (
                  <span className="muted" style={{ fontSize: 12 }}>
                    No existing tags yet — add one below.
                  </span>
                )}
                {unselectedTags.map((t) => (
                  <button
                    key={t}
                    onClick={() => toggleTag(t)}
                    style={{
                      background: 'var(--paper)',
                      color: 'var(--ink-soft)',
                      border: '1px solid var(--rule)',
                      borderRadius: 99,
                      padding: '4px 10px',
                      fontSize: 11.5,
                      fontFamily: 'var(--sans)',
                      cursor: 'pointer',
                    }}
                  >
                    + {t}
                  </button>
                ))}
              </div>
              <div className="row items-center gap-sm">
                <input
                  className="input"
                  value={draftTag}
                  onChange={(e) => setDraftTag(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      addCustomTag();
                    }
                  }}
                  placeholder="Add a new tag…"
                  style={{ flex: 1, fontSize: 12, padding: '6px 10px' }}
                />
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={addCustomTag}
                  disabled={!draftTag.trim()}
                >
                  Add
                </button>
              </div>
            </div>
          </div>

          {uploadStatus && uploading && (
            <div className="muted" style={{ fontSize: 12 }}>
              {uploadStatus}
            </div>
          )}
        </div>
        <div className="modal-footer" style={{ justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn" onClick={onClose} disabled={uploading}>
            Cancel
          </button>
          <button
            className="btn btn-accent"
            onClick={() => file && onUpload(file, tags)}
            disabled={!file || uploading}
          >
            {uploading
              ? 'Uploading…'
              : tags.length > 0
                ? `Upload & tag with ${tags.length} tag${tags.length === 1 ? '' : 's'}`
                : 'Upload'}
          </button>
        </div>
      </div>
    </div>
  );
}
