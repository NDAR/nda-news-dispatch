import { createFileRoute } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import {
  createImport,
  deleteAllContacts,
  deleteContact,
  getAudienceCount,
  getImport,
  getImportDownloadUrl,
  listContacts,
  listImports,
  listSuppressions,
  listTags,
  listTypes,
  patchContact,
  removeSuppression,
  upsertContact,
  uploadCsv,
  type Contact,
  type ImportFailure,
  type ImportJob,
  type NewsletterType,
  type Suppression,
  type SuppressionScope,
} from '../api/endpoints';

// Survives a tab-close / route-unmount within the same browser session so the
// import-status banner can keep polling and show completion when the user
// returns. Cleared by the dismiss button on the banner.
const IMPORT_ID_STORAGE_KEY = 'dispatch:lastImportId';

/**
 * Wraps a single API call in transient-error retries. The delete-all
 * endpoint takes up to ~20 s of server work per call, so a single 504 from
 * an unlucky Lambda timeout or a flaky network blip used to kill the
 * whole loop and leave the table half-wiped. Retries with backoff make
 * the loop self-healing for anything ≥ 500 or network-class — 4xx errors
 * (auth, validation) bypass retry so we don't mask real failures.
 *
 * `onAttempt` lets the caller surface "retrying (n/m)" in its UI between
 * the failed attempt and the next call.
 */
async function callWithRetry<T>(
  fn: () => Promise<T>,
  onAttempt?: (state: { attempt: number; max: number } | null) => void,
): Promise<T> {
  const MAX_ATTEMPTS = 4; // 1 initial + 3 retries
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const result = await fn();
      onAttempt?.(null);
      return result;
    } catch (e) {
      lastErr = e;
      if (!isTransientError(e) || attempt === MAX_ATTEMPTS) {
        onAttempt?.(null);
        throw e;
      }
      onAttempt?.({ attempt: attempt + 1, max: MAX_ATTEMPTS });
      // 1s, 2s, 4s
      await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
    }
  }
  throw lastErr;
}

function isTransientError(e: unknown): boolean {
  // `ApiError` exposes a numeric `status`; non-ApiError throws (TypeError
  // from fetch, AbortError, etc.) are network-class and always retryable.
  // We deliberately retry 5xx only — 4xx means the request itself is
  // wrong, retrying won't help.
  const status = (e as { status?: unknown } | undefined)?.status;
  if (typeof status === 'number') return status >= 500 && status < 600;
  return true;
}

export const Route = createFileRoute('/_app/subscribers')({
  component: SubscribersPage,
});

type View = 'subscribers' | 'suppressions' | 'imports';

const PAGE_SIZE = 200;

function SubscribersPage() {
  const qc = useQueryClient();
  const [view, setView] = useState<View>('subscribers');
  const [tagFilter, setTagFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<'' | 'active' | 'unsubscribed' | 'bounced'>('');
  // Search input vs. the debounced value we actually query with. Debouncing
  // keeps us from firing a Scan on every keystroke for what's already a
  // multi-page operation server-side.
  const [searchInput, setSearchInput] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setSearchTerm(searchInput.trim().toLowerCase()), 250);
    return () => clearTimeout(t);
  }, [searchInput]);

  // Cursor-stack pagination. `pageStack[i]` is the cursor used to fetch page
  // i (undefined for page 0). Pushing a new cursor moves forward; popping
  // moves back. We reset to page 0 whenever any filter changes — the cursors
  // from a previous filter set don't address the new query's result space.
  const [pageStack, setPageStack] = useState<(string | undefined)[]>([undefined]);
  const pageIndex = pageStack.length - 1;
  const currentCursor = pageStack[pageIndex];
  useEffect(() => {
    setPageStack([undefined]);
  }, [tagFilter, statusFilter, searchTerm]);

  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: ['contacts', tagFilter, statusFilter, searchTerm, currentCursor ?? ''],
    queryFn: () =>
      listContacts({
        ...(tagFilter ? { tag: tagFilter } : {}),
        ...(statusFilter ? { status: statusFilter } : {}),
        ...(searchTerm ? { q: searchTerm } : {}),
        ...(currentCursor ? { next: currentCursor } : {}),
        limit: PAGE_SIZE,
      }),
    placeholderData: (prev) => prev,
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
  const [deleteAllOpen, setDeleteAllOpen] = useState(false);
  // Initialize from sessionStorage so the import-status banner survives a
  // tab close or a navigation away from /subscribers within the same
  // session. The lazy initializer avoids SSR/window issues even though
  // we're CSR-only today.
  const [importId, setImportId] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    return window.sessionStorage.getItem(IMPORT_ID_STORAGE_KEY);
  });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (importId) window.sessionStorage.setItem(IMPORT_ID_STORAGE_KEY, importId);
    else window.sessionStorage.removeItem(IMPORT_ID_STORAGE_KEY);
  }, [importId]);
  // Cross-session recovery: if we landed on the page without a tracked
  // importId but the server has an in-flight import (pending/processing),
  // adopt it so the user sees progress and the eventual completion banner.
  // Runs once on mount; the importQuery below picks up the polling.
  //
  // Stale-record guard: if a Lambda timeout SIGKILLs the worker mid-run,
  // the `catch` block that writes `failed` never executes and the META
  // row gets stuck at `processing` forever. The worker's wall-clock budget
  // (5 min × up to 5 SQS retries with 6 min visibility) tops out around
  // 30 min, so anything older than 45 min in a non-terminal state is
  // definitively dead and should not be adopted.
  useEffect(() => {
    if (importId) return;
    let cancelled = false;
    const STALE_INFLIGHT_MS = 45 * 60_000;
    listImports()
      .then((res) => {
        if (cancelled) return;
        const now = Date.now();
        const inflight = res.items.find((j) => {
          // Only adopt CSV imports — delete-all audit rows live in the
          // same list but aren't something we poll on the Subscribers
          // page banner. They're recognizable by their type field, or
          // equivalently by the absence of an importId.
          if (j.type === 'delete-all' || !j.importId) return false;
          if (j.status !== 'pending' && j.status !== 'processing') return false;
          const last = Date.parse(j.updatedAt ?? j.createdAt);
          if (Number.isFinite(last) && now - last > STALE_INFLIGHT_MS) return false;
          return true;
        });
        if (inflight?.importId) setImportId(inflight.importId);
      })
      .catch(() => {
        /* best-effort; missing recovery isn't worth surfacing an error */
      });
    return () => {
      cancelled = true;
    };
    // Intentional one-shot on mount — we don't want to re-adopt an import
    // after the user has dismissed it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
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
      // TopBar's "X on the list" count + the Send page's audience preview
      // both have their own staleTime; without this they'd keep showing
      // pre-import values until the user navigates away and back.
      qc.invalidateQueries({ queryKey: ['audience-count'] });
      qc.invalidateQueries({ queryKey: ['audience-preview'] });
    }
  }, [importStatus, qc]);

  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="card">
        {/* Card-header is flex space-between by default. Adding wrap + gap
            lets the title block and the actions block stack vertically when
            the window narrows instead of pushing actions off-screen. The
            data filters (search/status/tag) moved out of here into a
            dedicated bar above the table — they belong with the data they
            slice, not with the page-level identity + primary actions. */}
        <div
          className="card-header"
          style={{ flexWrap: 'wrap', gap: 12, rowGap: 12 }}
        >
          <div className="row items-center gap-md" style={{ flexWrap: 'wrap' }}>
            <div>
              <div className="eyebrow">Audience</div>
              <h3 className="serif mt-sm">
                {view === 'subscribers'
                  ? 'Subscribers'
                  : view === 'suppressions'
                    ? 'Suppression list'
                    : 'Import history'}
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
              <button
                className={view === 'imports' ? 'active' : ''}
                onClick={() => setView('imports')}
              >
                Import history
              </button>
            </div>
          </div>
          {view === 'subscribers' && (
            <div
              className="row items-center gap-sm"
              style={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}
            >
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
              <button
                className="btn btn-sm"
                onClick={() => setDeleteAllOpen(true)}
                title="Delete every subscriber from the list"
                style={{ color: 'var(--bad)', borderColor: 'var(--bad)' }}
              >
                Delete all
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
          {view === 'imports' && <ImportHistoryPanel />}
          {view === 'subscribers' && (uploadStatus || importQuery.data) && (
            <div
              style={{
                padding: 12,
                borderRadius: 6,
                background: 'var(--paper-deep)',
                border: '1px solid var(--rule-soft)',
                marginBottom: 14,
                fontSize: 12.5,
                display: 'flex',
                alignItems: 'flex-start',
                gap: 12,
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                {importQuery.data ? (
                  (() => {
                    const counts = importQuery.data.counts ?? {
                      total: 0, inserted: 0, updated: 0, suppressed: 0, invalid: 0,
                    };
                    return (
                      <>
                        <strong>Import {importQuery.data.status}</strong>
                        {' · '}
                        {counts.total} rows —{' '}
                        {counts.inserted} new,{' '}
                        {counts.updated} updated,{' '}
                        {counts.suppressed} suppressed,{' '}
                        {counts.invalid} invalid
                        {importQuery.data.error && (
                          <div style={{ color: 'var(--bad)', marginTop: 4 }}>{importQuery.data.error}</div>
                        )}
                        {importQuery.data.status === 'done' &&
                          importQuery.data.failures &&
                          importQuery.data.failures.length > 0 && (
                            <ImportFailuresPanel
                              failures={importQuery.data.failures}
                              truncated={importQuery.data.failuresTruncated === true}
                              filename={importQuery.data.filename ?? importQuery.data.importId ?? 'failures'}
                            />
                          )}
                      </>
                    );
                  })()
                ) : (
                  <span className="muted">{uploadStatus}</span>
                )}
              </div>
              {/* Dismiss only after the worker has settled — we don't want the
                  user to accidentally drop tracking on a still-running import. */}
              {(importQuery.data?.status === 'done' || importQuery.data?.status === 'failed') && (
                <button
                  onClick={() => {
                    setImportId(null);
                    setUploadStatus('');
                  }}
                  title="Dismiss"
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--ink-mute)',
                    cursor: 'pointer',
                    fontSize: 16,
                    lineHeight: 1,
                    padding: '0 4px',
                  }}
                >
                  ×
                </button>
              )}
            </div>
          )}

          {view === 'subscribers' && (
            <div
              className="row items-center gap-sm"
              style={{
                flexWrap: 'wrap',
                marginBottom: 14,
                paddingBottom: 12,
                borderBottom: '1px solid var(--rule-soft)',
              }}
            >
              <input
                className="input"
                type="search"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder="Search by email…"
                style={{ flex: '1 1 220px', minWidth: 200, fontFamily: 'var(--mono)', fontSize: 12 }}
                title="Match a substring of the email address"
              />
              <select
                className="select"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
                style={{ flex: '0 1 160px', minWidth: 140 }}
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
                style={{ flex: '0 1 200px', minWidth: 160 }}
                disabled={tagsLoading}
              >
                <option value="">All tags</option>
                {knownTags.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </div>
          )}

          {view === 'subscribers' && isLoading && <p className="muted">Loading subscribers…</p>}
          {view === 'subscribers' && error && (
            <p style={{ color: 'var(--bad)' }}>Failed to load contacts: {(error as Error).message}</p>
          )}
          {view === 'subscribers' && data && (
            <>
              <div
                className="row items-center"
                style={{ marginBottom: 8, justifyContent: 'space-between', gap: 12 }}
              >
                <div className="muted" style={{ fontSize: 12 }}>
                  {(() => {
                    const start = pageIndex * PAGE_SIZE + 1;
                    const end = pageIndex * PAGE_SIZE + data.items.length;
                    if (data.items.length === 0) return 'No subscribers match this view.';
                    return `Showing ${start.toLocaleString()}–${end.toLocaleString()}`;
                  })()}
                  {statusFilter && ` · ${statusFilter}`}
                  {tagFilter && ` · tag "${tagFilter}"`}
                  {searchTerm && ` · matches "${searchTerm}"`}
                  {isFetching && ' · loading…'}
                </div>
                <PaginationControls
                  pageIndex={pageIndex}
                  hasNext={!!data.next}
                  disabled={isFetching}
                  onPrev={() => setPageStack((s) => (s.length > 1 ? s.slice(0, -1) : s))}
                  onNext={() => data.next && setPageStack((s) => [...s, data.next])}
                />
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
                        {searchTerm || statusFilter || tagFilter
                          ? 'No subscribers match the current filters.'
                          : 'No subscribers — upload a CSV to get started.'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
              {(pageIndex > 0 || data.next) && (
                <div
                  className="row items-center"
                  style={{ justifyContent: 'flex-end', marginTop: 12 }}
                >
                  <PaginationControls
                    pageIndex={pageIndex}
                    hasNext={!!data.next}
                    disabled={isFetching}
                    onPrev={() => setPageStack((s) => (s.length > 1 ? s.slice(0, -1) : s))}
                    onNext={() => data.next && setPageStack((s) => [...s, data.next])}
                  />
                </div>
              )}
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

      {deleteAllOpen && (
        <DeleteAllSubscribersModal
          onClose={() => setDeleteAllOpen(false)}
          onCompleted={() => {
            qc.invalidateQueries({ queryKey: ['contacts'] });
            qc.invalidateQueries({ queryKey: ['admin-tags'] });
            qc.invalidateQueries({ queryKey: ['audience-count'] });
            qc.invalidateQueries({ queryKey: ['audience-preview'] });
            // Surface the just-recorded delete-all audit row in the
            // Import history tab without waiting for the staleTime.
            qc.invalidateQueries({ queryKey: ['imports-list'] });
            setPageStack([undefined]);
          }}
        />
      )}
    </div>
  );
}

// ── Pagination ─────────────────────────────────────────────────────────────

function PaginationControls({
  pageIndex,
  hasNext,
  disabled,
  onPrev,
  onNext,
}: {
  pageIndex: number;
  hasNext: boolean;
  disabled: boolean;
  onPrev: () => void;
  onNext: () => void;
}) {
  const hasPrev = pageIndex > 0;
  if (!hasPrev && !hasNext) return null;
  return (
    <div className="row items-center gap-sm">
      <button
        className="btn btn-sm"
        onClick={onPrev}
        disabled={!hasPrev || disabled}
        title="Previous page"
      >
        ← Prev
      </button>
      <span className="muted mono-sm" style={{ fontSize: 11, minWidth: 64, textAlign: 'center' }}>
        Page {pageIndex + 1}
      </span>
      <button
        className="btn btn-sm"
        onClick={onNext}
        disabled={!hasNext || disabled}
        title="Next page"
      >
        Next →
      </button>
    </div>
  );
}

// ── Import failures panel ──────────────────────────────────────────────────

/**
 * Expandable list of addresses that didn't make it into the table from the
 * latest import — invalid email formats + addresses skipped because of an
 * existing global suppression. The "Download CSV" button serializes the
 * list client-side; no extra backend round-trip is needed because the
 * worker already attached the array to the IMPORT META row.
 */
function ImportFailuresPanel({
  failures,
  truncated,
  filename,
}: {
  failures: ImportFailure[];
  truncated: boolean;
  filename: string;
}) {
  const [open, setOpen] = useState(false);
  const invalidCount = failures.filter((f) => f.reason === 'invalid').length;
  const suppressedCount = failures.length - invalidCount;

  const downloadCsv = () => {
    const escape = (v: string) => {
      // RFC-4180-ish: wrap in quotes if the cell contains a comma, quote, or
      // newline, doubling embedded quotes. Most failure emails won't need
      // it, but raw invalid-row cells can contain anything.
      if (/[",\n\r]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
      return v;
    };
    const lines = ['email,reason', ...failures.map((f) => `${escape(f.email)},${f.reason}`)];
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const base = filename.replace(/\.csv$/i, '').replace(/[^a-z0-9._-]+/gi, '_').slice(0, 60) || 'import';
    a.download = `${base}-failures.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div style={{ marginTop: 8 }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          background: 'transparent',
          border: 'none',
          color: 'var(--accent-deep, var(--ink-soft))',
          cursor: 'pointer',
          fontSize: 12,
          padding: 0,
          textDecoration: 'underline',
        }}
      >
        {open ? '▾' : '▸'} View failed ({failures.length.toLocaleString()})
      </button>
      {open && (
        <div
          style={{
            marginTop: 8,
            border: '1px solid var(--rule-soft)',
            borderRadius: 4,
            background: 'var(--paper)',
            padding: 8,
          }}
        >
          <div
            className="row items-center"
            style={{ justifyContent: 'space-between', marginBottom: 6, gap: 8 }}
          >
            <span className="muted" style={{ fontSize: 11 }}>
              {invalidCount.toLocaleString()} invalid · {suppressedCount.toLocaleString()} suppressed
              {truncated && ' · list truncated (counts above are complete)'}
            </span>
            <button className="btn btn-sm" onClick={downloadCsv} title="Download as CSV">
              Download CSV
            </button>
          </div>
          <div
            style={{
              maxHeight: 240,
              overflowY: 'auto',
              fontFamily: 'var(--mono)',
              fontSize: 11.5,
              border: '1px solid var(--rule-soft)',
              borderRadius: 3,
              background: 'var(--paper-deep)',
            }}
          >
            <table className="table" style={{ margin: 0 }}>
              <thead style={{ position: 'sticky', top: 0, background: 'var(--paper)' }}>
                <tr>
                  <th style={{ fontSize: 11 }}>Email</th>
                  <th style={{ fontSize: 11, width: 110 }}>Reason</th>
                </tr>
              </thead>
              <tbody>
                {failures.map((f, i) => (
                  <tr key={`${f.reason}:${f.email}:${i}`}>
                    <td style={{ wordBreak: 'break-all' }}>{f.email || <span className="faint">(blank)</span>}</td>
                    <td>
                      <span className={`pill ${f.reason === 'invalid' ? 'failed' : 'draft'}`}>
                        {f.reason}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Import history panel ───────────────────────────────────────────────────

/**
 * Audit view of every CSV import the system has processed. Source data is
 * the IMPORT META rows in DDB (server keeps them indefinitely); the raw
 * CSV files live in the imports S3 bucket and are retained per its
 * lifecycle policy (currently 365 days) — beyond that the "Download"
 * button will 404 because the object is gone, but the metadata row
 * still tells the audit story.
 */
function ImportHistoryPanel() {
  const importsQ = useQuery({
    queryKey: ['imports-list'],
    queryFn: listImports,
    staleTime: 10_000,
  });
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Per-row toggle for the failures panel — only one row's failure list
  // expands at a time so the table stays scannable.
  const [openFailuresId, setOpenFailuresId] = useState<string | null>(null);

  const onDownload = async (job: ImportJob) => {
    // Guarded at the call site too — the button is disabled when
    // importId is missing — but the type system needs the narrowing.
    if (!job.importId) return;
    setDownloadingId(job.importId);
    setError(null);
    try {
      const { url } = await getImportDownloadUrl(job.importId);
      // Triggering a download via an anchor tag lets the browser follow
      // the presigned URL directly to S3 instead of fetching through the
      // app — important for large CSVs where streaming to disk beats
      // buffering into memory.
      const a = document.createElement('a');
      a.href = url;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } catch (e) {
      setError(
        e instanceof Error && e.message
          ? `Download failed: ${e.message}`
          : 'Download failed. The CSV may have aged out of retention.',
      );
    } finally {
      setDownloadingId(null);
    }
  };

  if (importsQ.isLoading) return <p className="muted">Loading import history…</p>;
  if (importsQ.error) {
    return (
      <p style={{ color: 'var(--bad)' }}>
        Failed to load history: {(importsQ.error as Error).message}
      </p>
    );
  }
  const items = importsQ.data?.items ?? [];

  return (
    <>
      <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
        {items.length === 0
          ? 'No activity yet — upload a CSV or run "Delete all" from the Subscribers tab.'
          : `${items.length} most recent event${items.length === 1 ? '' : 's'}. CSV uploads + bulk deletions appear here. Original CSV files are retained for 365 days.`}
      </div>
      {error && (
        <div style={{ color: 'var(--bad)', fontSize: 12, marginBottom: 8 }}>{error}</div>
      )}
      {items.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>When</th>
              <th>Action</th>
              <th>By</th>
              <th>Status</th>
              <th>Summary</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((job) => {
              const id = job.importId ?? job.operationId ?? '?';
              if (job.type === 'delete-all') {
                return <DeleteAllRow key={`op-${id}`} job={job} />;
              }
              return (
                <ImportRow
                  key={`imp-${id}`}
                  job={job}
                  failureOpen={openFailuresId === id}
                  onToggleFailures={() =>
                    setOpenFailuresId(openFailuresId === id ? null : id)
                  }
                  downloading={downloadingId === id}
                  onDownload={() => onDownload(job)}
                />
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );
}

function statusPillClass(status: ImportJob['status']): string {
  if (status === 'done') return 'sent';
  if (status === 'failed') return 'failed';
  return 'draft';
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

function ImportRow({
  job,
  failureOpen,
  onToggleFailures,
  downloading,
  onDownload,
}: {
  job: ImportJob;
  failureOpen: boolean;
  onToggleFailures: () => void;
  downloading: boolean;
  onDownload: () => void;
}) {
  const failureCount = job.failures?.length ?? 0;
  const counts = job.counts;
  return (
    <>
      <tr>
        <td className="mono-sm" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>{formatDate(job.createdAt)}</td>
        <td style={{ fontSize: 12 }}>
          <span className="pill" style={{ background: 'var(--paper-deep)', marginRight: 6 }}>Import</span>
          <span style={{ wordBreak: 'break-all' }}>
            {job.filename ?? <span className="faint">(unnamed)</span>}
          </span>
        </td>
        <td className="muted" style={{ fontSize: 12 }}>{job.createdBy ?? '—'}</td>
        <td>
          <span className={`pill ${statusPillClass(job.status)}`}>{job.status}</span>
        </td>
        <td className="muted" style={{ fontSize: 12 }}>
          {counts && (job.status === 'done' || job.status === 'failed') ? (
            <>
              {counts.total.toLocaleString()} rows
              <span className="faint" style={{ marginLeft: 6 }}>
                ({counts.inserted.toLocaleString()} new ·{' '}
                {counts.updated.toLocaleString()} upd ·{' '}
                {counts.suppressed.toLocaleString()} supp ·{' '}
                {counts.invalid.toLocaleString()} invalid)
              </span>
            </>
          ) : (
            <span className="faint">—</span>
          )}
        </td>
        <td className="text-right" style={{ whiteSpace: 'nowrap' }}>
          {failureCount > 0 && (
            <button
              className="btn btn-sm btn-ghost"
              onClick={onToggleFailures}
              style={{ marginRight: 6 }}
              title="View failed rows"
            >
              {failureOpen ? '▾' : '▸'} Failures ({failureCount.toLocaleString()})
            </button>
          )}
          <button
            className="btn btn-sm"
            onClick={onDownload}
            disabled={downloading || !job.importId}
            title="Download the original CSV"
          >
            {downloading ? 'Preparing…' : 'Download'}
          </button>
        </td>
      </tr>
      {failureOpen && job.failures && job.failures.length > 0 && (
        <tr>
          <td colSpan={6} style={{ background: 'var(--paper-deep)', padding: '8px 12px' }}>
            <ImportFailuresPanel
              failures={job.failures}
              truncated={job.failuresTruncated === true}
              filename={job.filename ?? job.importId ?? 'failures'}
            />
          </td>
        </tr>
      )}
    </>
  );
}

function DeleteAllRow({ job }: { job: ImportJob }) {
  const deleted = job.deleted ?? 0;
  // Show a duration when we have both endpoints. Useful for the audit
  // reader to see how long a large wipe took.
  let durationLabel: string | null = null;
  if (job.completedAt) {
    const start = Date.parse(job.createdAt);
    const end = Date.parse(job.completedAt);
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
      const seconds = Math.round((end - start) / 1000);
      if (seconds < 60) durationLabel = `${seconds}s`;
      else durationLabel = `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    }
  }
  return (
    <tr>
      <td className="mono-sm" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>{formatDate(job.createdAt)}</td>
      <td style={{ fontSize: 12 }}>
        <span
          className="pill"
          style={{ background: 'var(--bad)', color: 'var(--paper)', marginRight: 6 }}
        >
          Delete all
        </span>
        <span className="muted">active subscribers</span>
      </td>
      <td className="muted" style={{ fontSize: 12 }}>{job.createdBy ?? '—'}</td>
      <td>
        <span className={`pill ${statusPillClass(job.status)}`}>{job.status}</span>
      </td>
      <td className="muted" style={{ fontSize: 12 }}>
        {deleted.toLocaleString()} subscriber{deleted === 1 ? '' : 's'} removed
        {durationLabel && (
          <span className="faint" style={{ marginLeft: 6 }}>· {durationLabel}</span>
        )}
      </td>
      <td />
    </tr>
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

// ── Delete-all subscribers modal ───────────────────────────────────────────

/**
 * Destructive bulk-delete confirmation. Requires the user to type the
 * literal word "delete" before the action button enables — both because
 * this is irreversible AND because the affected count can be in the tens
 * of thousands.
 *
 * The backend processes what it can per API Gateway window (~25 s of work)
 * and returns `{ deleted, done }`; we loop until done, accumulating the
 * count for live progress. We pre-fetch the audience total just so the
 * warning copy can name a specific number ("This will delete N
 * subscribers") instead of being abstract.
 */
function DeleteAllSubscribersModal({
  onClose,
  onCompleted,
}: {
  onClose: () => void;
  onCompleted: () => void;
}) {
  const CONFIRM_WORD = 'delete';
  const [confirmation, setConfirmation] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deletedSoFar, setDeletedSoFar] = useState(0);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Pre-flight count so the warning copy is specific. Shares the
  // ['audience-count'] cache with the TopBar so opening this modal after
  // the page has loaded is free.
  const audienceQ = useQuery({
    queryKey: ['audience-count'],
    queryFn: getAudienceCount,
    staleTime: 60_000,
  });
  const total = audienceQ.data?.count;

  // Esc closes the modal — but only when no work is in flight. Once a
  // deletion has started the user must wait for it to finish (or close
  // the tab and accept that the next page load resumes nothing — there's
  // no resume path for bulk delete, deliberately).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !deleting) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [deleting, onClose]);

  const armed = confirmation.trim().toLowerCase() === CONFIRM_WORD && !deleting && !done;
  const [retrying, setRetrying] = useState<{ attempt: number; max: number } | null>(null);

  const runDelete = async () => {
    setDeleting(true);
    setError(null);
    setDeletedSoFar(0);
    setRetrying(null);
    // One UUID per click — linked through every iteration so the server
    // can fold cumulative progress into a single audit row that shows up
    // in the import-history view. `crypto.randomUUID` is widely
    // supported in all browsers we target.
    const operationId = crypto.randomUUID();
    try {
      // Server bounds each call to ~20 s; loop until done. Stale items
      // produced by concurrent writes during the loop are caught by the
      // next iteration because each call starts a fresh scan.
      let cumulative = 0;
      // Hard safety net so a server bug can't spin this loop forever. At
      // ~20 s per call, 40 iterations is ~13 minutes of work — far more
      // than any realistic subscriber count would need.
      const MAX_ITERATIONS = 40;
      for (let i = 0; i < MAX_ITERATIONS; i++) {
        const res = await callWithRetry(() => deleteAllContacts(operationId), setRetrying);
        cumulative += res.deleted;
        setDeletedSoFar(cumulative);
        if (res.done) {
          setDone(true);
          onCompleted();
          return;
        }
      }
      setError('Deletion is taking longer than expected. Some subscribers may remain — try again to finish.');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRetrying(null);
      setDeleting(false);
    }
  };

  return (
    <div
      className="modal-backdrop"
      onClick={() => {
        if (!deleting) onClose();
      }}
    >
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 480 }}>
        <div className="modal-header">
          <div>
            <div className="eyebrow" style={{ color: 'var(--bad)' }}>Destructive action</div>
            <h3 className="serif mt-sm">Delete all subscribers?</h3>
          </div>
        </div>
        <div className="modal-body stack" style={{ gap: 14 }}>
          <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5 }}>
            This permanently removes{' '}
            <strong>
              {total !== undefined
                ? `all ${total.toLocaleString()} active subscriber${total === 1 ? '' : 's'}`
                : 'every active subscriber'}
            </strong>{' '}
            from your list, including their tags. It <strong>cannot be undone</strong>.
          </p>
          <p className="muted" style={{ margin: 0, fontSize: 12, lineHeight: 1.5 }}>
            Preserved: unsubscribed and bounced contact records (so the system still remembers them),
            your suppression list, and import history. Re-uploading a CSV will not re-add anyone who
            previously unsubscribed, bounced, or was added to the suppression list.
          </p>
          <div>
            <div className="label">
              Type <code style={{ background: 'var(--paper-deep)', padding: '1px 4px', borderRadius: 2 }}>{CONFIRM_WORD}</code> to confirm
            </div>
            <input
              className="input"
              autoFocus
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && armed) runDelete();
              }}
              disabled={deleting || done}
              placeholder={CONFIRM_WORD}
              style={{ fontFamily: 'var(--mono)', fontSize: 13, padding: '8px 10px' }}
            />
          </div>
          {(deleting || deletedSoFar > 0) && (
            <div
              style={{
                padding: 10,
                background: 'var(--paper-deep)',
                border: '1px solid var(--rule-soft)',
                borderRadius: 4,
                fontSize: 12.5,
              }}
            >
              {done ? (
                <>✓ Deleted {deletedSoFar.toLocaleString()} subscriber{deletedSoFar === 1 ? '' : 's'}.</>
              ) : (
                <>
                  Deleting… {deletedSoFar.toLocaleString()} removed so far
                  {retrying && (
                    <span className="muted" style={{ marginLeft: 8, fontSize: 11 }}>
                      · retrying ({retrying.attempt}/{retrying.max})
                    </span>
                  )}
                </>
              )}
            </div>
          )}
          {error && (
            <div style={{ color: 'var(--bad)', fontSize: 12 }}>{error}</div>
          )}
        </div>
        <div className="modal-footer" style={{ justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn btn-sm" onClick={onClose} disabled={deleting}>
            {done ? 'Close' : 'Cancel'}
          </button>
          {!done && (
            <button
              className="btn btn-sm"
              onClick={runDelete}
              disabled={!armed}
              style={{
                background: armed ? 'var(--bad)' : undefined,
                borderColor: armed ? 'var(--bad)' : undefined,
                color: armed ? 'var(--paper)' : undefined,
              }}
            >
              {deleting ? 'Deleting…' : 'Delete all subscribers'}
            </button>
          )}
        </div>
      </div>
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
