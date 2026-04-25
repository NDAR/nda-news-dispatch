import { createFileRoute } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import {
  createImport,
  deleteContact,
  getImport,
  listContacts,
  listTags,
  uploadCsv,
} from '../api/endpoints';

export const Route = createFileRoute('/_app/subscribers')({
  component: SubscribersPage,
});

function SubscribersPage() {
  const qc = useQueryClient();
  const [tagFilter, setTagFilter] = useState('');
  const { data, isLoading, error } = useQuery({
    queryKey: ['contacts', tagFilter],
    queryFn: () => listContacts(tagFilter ? { tag: tagFilter, limit: 200 } : { limit: 200 }),
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
          <div>
            <div className="eyebrow">Audience</div>
            <h3 className="serif mt-sm">Subscribers</h3>
          </div>
          <div className="row items-center gap-sm">
            <select
              className="select"
              value={tagFilter}
              onChange={(e) => setTagFilter(e.target.value)}
              style={{ width: 220 }}
              disabled={tagsLoading}
            >
              <option value="">All subscribers</option>
              {knownTags.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
            <button
              className="btn btn-accent btn-sm"
              onClick={() => setUploadOpen(true)}
              disabled={uploading}
            >
              Upload CSV
            </button>
          </div>
        </div>
        <div className="card-body">
          {(uploadStatus || importQuery.data) && (
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

          {isLoading && <p className="muted">Loading subscribers…</p>}
          {error && (
            <p style={{ color: 'var(--bad)' }}>Failed to load contacts: {(error as Error).message}</p>
          )}
          {data && (
            <>
              <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
                Showing {data.items.length} subscriber{data.items.length === 1 ? '' : 's'}
                {tagFilter && ` with tag "${tagFilter}"`}
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
                        {c.tags.length === 0 ? (
                          <span className="faint" style={{ fontSize: 11 }}>—</span>
                        ) : (
                          c.tags.map((t) => (
                            <span key={t} className="pill" style={{ marginRight: 4 }}>
                              {t}
                            </span>
                          ))
                        )}
                      </td>
                      <td>
                        <span className={`pill ${c.status === 'active' ? 'sent' : 'draft'}`}>
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
