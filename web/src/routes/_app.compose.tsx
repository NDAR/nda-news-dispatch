import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  createTemplate,
  deleteTemplate,
  getSettings,
  listTemplates,
  listTypes,
  testSendTemplate,
  updateTemplate,
  type Asset,
  type NewsletterType,
  type OrgSettings,
  type Template,
} from '../api/endpoints';
import { AssetPickerModal } from '../components/AssetPickerModal';
import { RichHtmlEditor, type RichHtmlEditorHandle } from '../components/RichHtmlEditor';
import { TypePill } from '../components/types/TypePill';
import { renderFooterPreviewHtml } from '../lib/footerPreview';
import { buildPreviewSrcDoc } from '../lib/previewFrame';

export const Route = createFileRoute('/_app/compose')({
  component: ComposePage,
});

const LIST_COLLAPSE_KEY = 'dispatch.compose.list.collapsed';
const ASSET_BASE_KEY = 'dispatch.compose.assetBase';
const EDITOR_MODE_KEY = 'dispatch.compose.editorMode';
const SPLIT_RATIO_KEY = 'dispatch.compose.splitRatio';
const MIN_PANE_PCT = 20;
const MAX_PANE_PCT = 80;

type EditorMode = 'visual' | 'code';

const DEFAULT_HTML = `<!doctype html>
<html><body style="font-family:Georgia,serif;max-width:600px;margin:0 auto;padding:32px">
  <h1>Your newsletter</h1>
  <p>Start composing here.</p>
</body></html>`;

const SEND_PRESELECT_KEY = 'dispatch.send.preselectTemplate';
const LAST_TYPE_KEY = 'dispatch.compose.lastType';

function ComposePage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data: templates = [], isLoading, error } = useQuery({
    queryKey: ['templates'],
    queryFn: async () => {
      const t = await listTemplates();
      console.log('[templates] loaded', t);
      return t;
    },
  });
  const { data: types = [] } = useQuery({
    queryKey: ['types', false],
    queryFn: () => listTypes(),
  });
  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: getSettings,
  });
  const [previewOpen, setPreviewOpen] = useState(false);
  const typeById = useMemo(() => new Map(types.map((t) => [t.id, t])), [types]);
  // The "+ New newsletter" flow: pick a type first, then create. The picker
  // pops over the sidebar; cancelling closes it without creating.
  const [picking, setPicking] = useState<{ open: boolean }>({ open: false });

  const [currentId, setCurrentId] = useState<string | null>(null);
  const [listCollapsed, setListCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(LIST_COLLAPSE_KEY) === '1';
  });
  useEffect(() => {
    window.localStorage.setItem(LIST_COLLAPSE_KEY, listCollapsed ? '1' : '0');
  }, [listCollapsed]);

  const [assetBase, setAssetBase] = useState<string>(() => {
    if (typeof window === 'undefined') return '';
    return window.localStorage.getItem(ASSET_BASE_KEY) ?? '';
  });
  useEffect(() => {
    window.localStorage.setItem(ASSET_BASE_KEY, assetBase);
  }, [assetBase]);

  const [editorMode, setEditorMode] = useState<EditorMode>(() => {
    if (typeof window === 'undefined') return 'visual';
    const saved = window.localStorage.getItem(EDITOR_MODE_KEY);
    return saved === 'code' || saved === 'visual' ? (saved as EditorMode) : 'visual';
  });
  useEffect(() => {
    window.localStorage.setItem(EDITOR_MODE_KEY, editorMode);
  }, [editorMode]);

  const [splitRatio, setSplitRatio] = useState<number>(() => {
    if (typeof window === 'undefined') return 50;
    const saved = Number(window.localStorage.getItem(SPLIT_RATIO_KEY));
    return Number.isFinite(saved) && saved >= MIN_PANE_PCT && saved <= MAX_PANE_PCT ? saved : 50;
  });
  useEffect(() => {
    window.localStorage.setItem(SPLIT_RATIO_KEY, String(splitRatio));
  }, [splitRatio]);
  const splitRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  function startDrag(e: React.MouseEvent) {
    e.preventDefault();
    draggingRef.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    const onMove = (ev: MouseEvent) => {
      if (!draggingRef.current || !splitRef.current) return;
      const rect = splitRef.current.getBoundingClientRect();
      const pct = ((ev.clientX - rect.left) / rect.width) * 100;
      setSplitRatio(Math.min(MAX_PANE_PCT, Math.max(MIN_PANE_PCT, pct)));
    };
    const onUp = () => {
      draggingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  // Snapshot of the original (pre-WYSIWYG) HTML, captured the first time the
  // user enters Visual mode for a given template. Lets us offer a "Restore
  // HTML" button if visual editing has lost meaningful detail.
  // Reset whenever the active template changes (handled in the localHtml reset
  // effect below).
  const originalHtmlRef = useRef<string | null>(null);
  // Whether we've already shown the fidelity-loss confirm for this template,
  // so the user only has to acknowledge it once per template per session.
  const fidelityWarnedRef = useRef<Set<string>>(new Set());
  const current = useMemo(
    () => templates.find((t) => t.id === currentId) ?? templates[0],
    [templates, currentId],
  );
  useEffect(() => {
    if (!currentId && templates[0]) setCurrentId(templates[0].id);
  }, [templates, currentId]);

  // Always-fresh ref to the current template so timer/mutation closures
  // never read a stale snapshot when the cache or selection changes mid-save.
  const currentRef = useRef(current);
  useEffect(() => { currentRef.current = current; }, [current]);

  // DynamoDB GSI writes are eventually consistent (usually <5s, sometimes
  // more). A refetch-after-POST often still reads the old index, so instead
  // we update the query cache directly with the record the API just returned.
  const createMut = useMutation({
    mutationFn: (typeId: string) => {
      const t = typeById.get(typeId);
      const subject = t?.defaultSubjectPrefix?.trim() ?? '';
      const html = t?.defaultBodyHtml?.trim() ? t.defaultBodyHtml : DEFAULT_HTML;
      return createTemplate({
        title: 'Untitled newsletter',
        subject,
        html,
        targetTags: [],
        typeId,
      });
    },
    onSuccess: (t) => {
      qc.setQueryData<Template[]>(['templates'], (old) => [t, ...(old ?? [])]);
      setCurrentId(t.id);
      if (t.typeId) window.localStorage.setItem(LAST_TYPE_KEY, t.typeId);
      setPicking({ open: false });
    },
    onError: (e) => {
      console.error('createTemplate failed', e);
    },
  });

  const updateMut = useMutation({
    mutationFn: (patch: Partial<Template>) => {
      const c = currentRef.current;
      if (!c) throw new Error('no current template');
      // Guard against the literal string "undefined" sneaking in via a stale
      // cache (which used to happen when CloudFront returned SPA-HTML in place
      // of the API response). Without this, the SPA endlessly PUTs to
      // /admin/templates/undefined and gets 403'd.
      if (!c.id || typeof c.id !== 'string' || c.id === 'undefined') {
        throw new Error(`current template id is invalid (${JSON.stringify(c.id)}). Hard-refresh to reload.`);
      }
      console.log('[compose] saving', c.id, 'htmlLen=', (patch.html ?? '').length);
      return updateTemplate(c.id, { ...c, ...patch });
    },
    onSuccess: (t) => {
      // Log full shape so we can see exactly what the server returned —
      // including missing fields, error wrappers, or truncation.
      console.log('[compose] saved — full response:', t);
      console.log('[compose] saved', {
        id: t?.id,
        version: t?.version,
        serverHtmlLen: typeof t?.html === 'string' ? t.html.length : `(missing: ${typeof t?.html})`,
        serverTitle: t?.title,
        serverSubject: t?.subject,
      });
      if (!t || !t.id) {
        console.error('[compose] response missing id — cache not updated');
        return;
      }
      qc.setQueryData<Template[]>(['templates'], (old) =>
        (old ?? []).map((x) => {
          if (x.id !== t.id) return x;
          // Defensive merge: if server omitted any field, keep the prior value
          // so the cache + UI never end up with `undefined` on a known-string
          // field. Prevents the renderer from crashing on `current.html.length`.
          return {
            ...x,
            ...t,
            html: typeof t.html === 'string' ? t.html : x.html,
            subject: typeof t.subject === 'string' ? t.subject : x.subject,
            title: typeof t.title === 'string' ? t.title : x.title,
          };
        }),
      );
    },
    onError: (e) => console.error('[compose] save failed', e),
  });

  // "Send to yourself" — flushes any pending edit (so the test reflects what
  // the user is currently looking at, not the last autosave) before calling
  // the test-send endpoint. Recipient defaults to the signed-in user's email
  // server-side, so no input is needed here.
  const testSendMut = useMutation({
    mutationFn: async () => {
      const c = currentRef.current;
      if (!c?.id) throw new Error('No newsletter selected');
      if (!localSubject.trim()) throw new Error('Add a subject line before sending a test');
      if (!localHtml.trim()) throw new Error('Newsletter has no content');
      const dirty =
        localHtml !== c.html || localSubject !== c.subject || localTitle !== c.title;
      if (dirty) {
        await updateTemplate(c.id, { ...c, html: localHtml, subject: localSubject, title: localTitle });
      }
      return testSendTemplate(c.id);
    },
    onError: (e) => console.error('test-send failed', e),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => deleteTemplate(id),
    onSuccess: (_, id) => {
      qc.setQueryData<Template[]>(['templates'], (old) =>
        (old ?? []).filter((x) => x.id !== id),
      );
      setCurrentId(null);
    },
    onError: (e) => console.error('deleteTemplate failed', e),
  });

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const visualEditorRef = useRef<RichHtmlEditorHandle | null>(null);
  const [imagePickerOpen, setImagePickerOpen] = useState(false);

  const [localHtml, setLocalHtml] = useState(current?.html ?? '');
  const [localSubject, setLocalSubject] = useState(current?.subject ?? '');
  const [localTitle, setLocalTitle] = useState(current?.title ?? '');

  // Reset on template switch: pull fresh content into local state. The Jodit
  // wrapper is controlled from this same string state, so it reseeds from here.
  useEffect(() => {
    console.log('[reset-local]', { id: current?.id, htmlLen: current?.html?.length });
    const newHtml = current?.html ?? '';
    setLocalHtml(newHtml);
    setLocalSubject(current?.subject ?? '');
    setLocalTitle(current?.title ?? '');
    originalHtmlRef.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id]);

  // Switch into visual mode. If the user has hand-coded HTML that Jodit may
  // simplify (tables, <style>, lots of inline styles), warn them once per
  // template and snapshot the original so they can restore later.
  function requestVisualMode() {
    const id = current?.id;
    if (!id) {
      setEditorMode('visual');
      return;
    }
    const looksComplex = /<table|<style|style="[^"]{40,}/i.test(localHtml);
    const alreadyWarned = fidelityWarnedRef.current.has(id);
    if (looksComplex && !alreadyWarned) {
      const ok = window.confirm(
        'Visual mode may simplify hand-coded HTML — tables, <style> blocks, and complex inline styles can be normalized or stripped.\n\n' +
        'A snapshot of the current HTML will be kept. You can click "Restore HTML" in HTML mode to revert.\n\nContinue?',
      );
      if (!ok) return;
      fidelityWarnedRef.current.add(id);
    }
    if (originalHtmlRef.current === null) {
      originalHtmlRef.current = localHtml;
    }
    setEditorMode('visual');
  }

  function restoreOriginalHtml() {
    const original = originalHtmlRef.current;
    if (original === null) return;
    setLocalHtml(original);
    originalHtmlRef.current = null;
  }

  const canRestore = editorMode === 'code' && originalHtmlRef.current !== null && originalHtmlRef.current !== localHtml;

  // Insert a chosen asset into whichever editor is active. In Code mode we
  // splice raw markup at the textarea's caret to preserve the surrounding
  // HTML structure the user is hand-editing.
  function handleAssetSelect(asset: Asset) {
    setImagePickerOpen(false);
    const alt = asset.filename.replace(/\.[a-z0-9]+$/i, '').replace(/-/g, ' ');
    const tag = `<img src="${asset.url}" alt="${escapeAttr(alt)}" style="max-width:100%;height:auto" />`;
    if (editorMode === 'visual') {
      const editor = visualEditorRef.current;
      if (!editor) {
        setLocalHtml((prev) => prev + (prev.endsWith('\n') ? '' : '\n') + tag);
        return;
      }
      editor.focus();
      editor.s.insertHTML(tag);
      setLocalHtml(editor.getEditorValue());
      return;
    }
    const ta = textareaRef.current;
    if (!ta) {
      setLocalHtml((prev) => prev + (prev.endsWith('\n') ? '' : '\n') + tag);
      return;
    }
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const next = localHtml.slice(0, start) + tag + localHtml.slice(end);
    setLocalHtml(next);
    requestAnimationFrame(() => {
      ta.focus();
      const pos = start + tag.length;
      ta.setSelectionRange(pos, pos);
    });
  }

  const previewDoc = useMemo(
    () => buildPreviewSrcDoc(localHtml, { baseHref: assetBase || undefined }),
    [assetBase, localHtml],
  );

  // Debounced autosave — fires 750ms after the last keystroke. We use the
  // currentRef (declared above) so the timer never fires against a stale id
  // (e.g. when a fresh template was just created but React re-renders haven't
  // settled yet).
  useEffect(() => {
    const c = currentRef.current;
    if (!c?.id || c.id === 'undefined') {
      console.warn('[autosave-skip] current has no usable id', c?.id);
      return;
    }
    // If the server record is missing html/subject/title for any reason,
    // treat it as "no change" rather than overwriting with whatever's in
    // local state. Otherwise an undefined-vs-string mismatch would trigger
    // a save that wipes the field server-side.
    if (typeof c.html !== 'string' || typeof c.subject !== 'string' || typeof c.title !== 'string') {
      console.warn('[autosave-skip] current is missing string field', {
        id: c.id,
        html: typeof c.html, subject: typeof c.subject, title: typeof c.title,
      });
      return;
    }
    const noChange =
      localHtml === c.html &&
      localSubject === c.subject &&
      localTitle === c.title;
    console.log('[autosave-check]', {
      id: c.id, noChange,
      localHtmlLen: localHtml.length,
      currentHtmlLen: c.html.length,
      localTitle, currentTitle: c.title,
    });
    if (noChange) return;
    const t = setTimeout(() => {
      const c2 = currentRef.current;
      if (!c2?.id) return;
      console.log('[autosave-fire]', c2.id, 'htmlLen', localHtml.length);
      updateMut.mutate({ html: localHtml, subject: localSubject, title: localTitle });
    }, 750);
    return () => clearTimeout(t);
    // updateMut intentionally omitted — we only re-schedule when the inputs change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localHtml, localSubject, localTitle, current?.id]);

  if (isLoading) return <p className="muted">Loading templates…</p>;
  if (error) return <p style={{ color: 'var(--bad)' }}>Failed to load templates: {(error as Error).message}</p>;

  return (
    <>
    <div style={{ display: 'grid', gridTemplateColumns: listCollapsed ? '40px 1fr' : '280px 1fr', gap: 20, transition: 'grid-template-columns 0.15s ease' }}>
      <div className="card" style={{ position: 'sticky', top: 24, maxHeight: 'calc(100vh - 60px)', display: 'flex', flexDirection: 'column' }}>
        {listCollapsed ? (
          <button
            onClick={() => setListCollapsed(false)}
            title="Expand newsletter list"
            aria-label="Expand newsletter list"
            style={{
              width: '100%', padding: '12px 0', border: 'none', background: 'transparent',
              cursor: 'pointer', color: 'var(--ink-soft)', fontSize: 16,
              writingMode: 'vertical-rl', transform: 'rotate(180deg)', height: '100%',
            }}
          >
            › Newsletters ({templates.length})
          </button>
        ) : (
          <>
            <div style={{ padding: 14, borderBottom: '1px solid var(--rule-soft)' }}>
              <div className="row items-center justify-between" style={{ marginBottom: 0 }}>
                <div className="eyebrow">Newsletters</div>
                <button
                  onClick={() => setListCollapsed(true)}
                  title="Collapse newsletter list"
                  aria-label="Collapse newsletter list"
                  style={{
                    border: 'none', background: 'transparent', cursor: 'pointer',
                    color: 'var(--ink-mute)', fontSize: 14, padding: 2, lineHeight: 1,
                  }}
                >
                  ‹
                </button>
              </div>
              <button
                className="btn btn-primary btn-sm"
                style={{ width: '100%', marginTop: 10, justifyContent: 'center' }}
                onClick={() => {
                  // No types yet → bounce to the management page so the user
                  // creates one first. Required-typeId means createTemplate
                  // would otherwise 400.
                  if (types.length === 0) {
                    navigate({ to: '/types' });
                    return;
                  }
                  setPicking({ open: true });
                }}
                disabled={createMut.isPending}
              >
                {createMut.isPending ? 'Creating…' : '+ New newsletter'}
              </button>
              {picking.open && (
                <NewTypePicker
                  types={types}
                  defaultTypeId={window.localStorage.getItem(LAST_TYPE_KEY) ?? types[0]?.id ?? ''}
                  onPick={(typeId) => createMut.mutate(typeId)}
                  onCancel={() => setPicking({ open: false })}
                  pending={createMut.isPending}
                />
              )}
              {createMut.error && (
                <div style={{ marginTop: 10, padding: 8, background: 'oklch(0.95 0.05 25)', color: 'var(--bad)', borderRadius: 4, fontSize: 12 }}>
                  {(createMut.error as Error).message}
                </div>
              )}
            </div>
            <div style={{ overflow: 'auto', flex: 1 }}>
              {templates.length === 0 && (
                <div className="muted" style={{ padding: 14, fontSize: 13 }}>
                  No newsletters yet — create one to get started.
                </div>
              )}
              {templates.map((t) => {
                const active = t.id === current?.id;
                return (
                  <button
                    key={t.id}
                    onClick={() => setCurrentId(t.id)}
                    style={{
                      display: 'block',
                      width: '100%',
                      textAlign: 'left',
                      padding: '12px 14px',
                      border: 'none',
                      borderBottom: '1px solid var(--rule-soft)',
                      background: active ? 'var(--paper-deep)' : 'transparent',
                      borderLeft: active ? '2px solid var(--accent)' : '2px solid transparent',
                      cursor: 'pointer',
                    }}
                  >
                    <div className="serif" style={{ fontSize: 14, fontWeight: active ? 500 : 400 }}>
                      {t.title || 'Untitled'}
                    </div>
                    <div className="muted" style={{ fontSize: 11, marginTop: 3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {t.subject || '(no subject)'}
                    </div>
                    <div className="row items-center" style={{ gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                      <TypePill type={t.typeId ? typeById.get(t.typeId) : undefined} />
                      <span className="muted" style={{ fontSize: 10, fontFamily: 'var(--mono)' }}>
                        v{t.version} · {new Date(t.updatedAt).toLocaleDateString()}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          </>
        )}
      </div>

      {current ? (
        <div className="stack" style={{ gap: 16 }}>
          <div className="card">
            <div className="card-body" style={{ padding: 16 }}>
              <div className="row gap-md" style={{ marginBottom: 12, alignItems: 'flex-end' }}>
                <div style={{ flex: 1 }}>
                  <div className="label">Newsletter title (internal)</div>
                  <input
                    className="input"
                    value={localTitle}
                    onChange={(e) => setLocalTitle(e.target.value)}
                    style={{ fontFamily: 'var(--serif)', fontSize: 16, padding: '10px 12px' }}
                  />
                </div>
                <div style={{ flex: '0 0 220px' }}>
                  <div className="label">Type</div>
                  <select
                    className="select"
                    value={current.typeId ?? ''}
                    onChange={(e) => {
                      const newTypeId = e.target.value;
                      if (!newTypeId || newTypeId === current.typeId) return;
                      // Persist via the existing autosave path so the change
                      // flushes immediately. Don't rewrite subject here — that
                      // would clobber user-edited content.
                      updateMut.mutate({ typeId: newTypeId });
                      window.localStorage.setItem(LAST_TYPE_KEY, newTypeId);
                    }}
                    style={{ fontSize: 13, padding: '10px 12px' }}
                  >
                    {!current.typeId && <option value="">— pick a type —</option>}
                    {types.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div>
                <div className="label">Subject line</div>
                <input
                  className="input"
                  value={localSubject}
                  onChange={(e) => setLocalSubject(e.target.value)}
                  style={{ fontFamily: 'var(--serif)', fontSize: 15, padding: '10px 12px' }}
                />
              </div>
            </div>
          </div>

          <p className="muted" style={{ fontSize: 12, margin: '0 0 8px' }}>
            A standard footer with your unsubscribe link is added automatically on send — you don't need to include one here. Edit it on the <a href="/settings" style={{ color: 'inherit', textDecoration: 'underline' }}>Settings</a> page.
          </p>

          <div
            ref={splitRef}
            className="split"
            style={{
              gridTemplateColumns:
                editorMode === 'visual'
                  ? '1fr'
                  : `${splitRatio}% 6px ${100 - splitRatio}%`,
              gridTemplateRows: '1fr',
              gap: 0,
            }}
          >
            <div className="split-pane">
              <div className="split-pane-header" style={{ gap: 8 }}>
                <div className="editor-mode-toggle" role="tablist" aria-label="Editor mode">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={editorMode === 'visual'}
                    className={`editor-mode-btn ${editorMode === 'visual' ? 'active' : ''}`}
                    onClick={() => {
                      if (editorMode !== 'visual') requestVisualMode();
                    }}
                  >
                    Visual
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={editorMode === 'code'}
                    className={`editor-mode-btn ${editorMode === 'code' ? 'active' : ''}`}
                    onClick={() => setEditorMode('code')}
                  >
                    HTML
                  </button>
                </div>
                <button
                  type="button"
                  className="btn btn-sm"
                  style={{ fontSize: 11, padding: '3px 8px' }}
                  onClick={() => setImagePickerOpen(true)}
                  title="Upload or pick a previously-uploaded image"
                >
                  + Image
                </button>
                <span className="faint mono-sm" style={{ flex: 1, textAlign: 'right' }}>
                  {(current.id ?? '').slice(0, 8)} · v{current.version} · {localHtml.length.toLocaleString()} chars
                </span>
              </div>
              <div className="split-pane-body">
                {editorMode === 'code' ? (
                  <div style={{ position: 'relative', height: '100%' }}>
                    <textarea
                      ref={textareaRef}
                      className="code-editor"
                      value={localHtml}
                      onChange={(e) => setLocalHtml(e.target.value)}
                      spellCheck={false}
                    />
                    {canRestore && (
                      <button
                        type="button"
                        onClick={restoreOriginalHtml}
                        title="Replace the current HTML with the snapshot taken before Visual mode was first enabled for this newsletter."
                        style={{
                          position: 'absolute', top: 8, right: 8, fontSize: 11,
                          padding: '4px 8px', border: '1px solid var(--rule)',
                          background: 'var(--paper)', color: 'var(--ink-soft)',
                          cursor: 'pointer', fontFamily: 'var(--sans)',
                        }}
                      >
                        Restore HTML
                      </button>
                    )}
                  </div>
                ) : (
                  <RichHtmlEditor
                    value={localHtml}
                    onChange={setLocalHtml}
                    onReady={(editor) => {
                      visualEditorRef.current = editor;
                    }}
                    onPickImage={() => setImagePickerOpen(true)}
                  />
                )}
              </div>
            </div>
            {editorMode === 'code' && (
              <>
                <div
                  role="separator"
                  aria-orientation="vertical"
                  aria-label="Resize editor and preview"
                  onMouseDown={startDrag}
                  onDoubleClick={() => setSplitRatio(50)}
                  title="Drag to resize · double-click to reset"
                  style={{
                    cursor: 'col-resize',
                    background: 'var(--rule)',
                    position: 'relative',
                    userSelect: 'none',
                  }}
                >
                  <div
                    style={{
                      position: 'absolute',
                      inset: '50% -4px auto -4px',
                      transform: 'translateY(-50%)',
                      height: 32,
                      borderLeft: '1px solid var(--rule-soft)',
                      borderRight: '1px solid var(--rule-soft)',
                      pointerEvents: 'none',
                    }}
                  />
                </div>
                <div className="split-pane">
                  <div className="split-pane-header" style={{ gap: 8 }}>
                    <span className="mono-sm">Preview</span>
                <input
                  className="input"
                  value={assetBase}
                  onChange={(e) => setAssetBase(e.target.value)}
                  placeholder="Asset base URL (e.g. https://example.org)"
                  title="Resolves relative <img>/<a> URLs in the preview. Saved per-browser."
                  style={{ flex: 1, fontSize: 11, padding: '4px 8px', fontFamily: 'var(--mono)' }}
                />
              </div>
                  <div className="split-pane-body preview-shell">
                    <iframe
                      className="preview-page"
                      style={{ border: 'none' }}
                      title="preview"
                      srcDoc={previewDoc}
                      sandbox=""
                    />
                  </div>
                </div>
              </>
            )}
          </div>

          <div className="row items-center justify-between" style={{ paddingTop: 4 }}>
            <div style={{ fontSize: 13 }}>
              {updateMut.isPending && <span className="muted">Saving…</span>}
              {updateMut.isSuccess && !updateMut.isPending && (
                <span className="muted">
                  Saved · v{current.version} · {(current.html?.length ?? 0).toLocaleString()} chars on server
                </span>
              )}
              {updateMut.error && (
                <span style={{ color: 'var(--bad)' }}>
                  Save failed: {(updateMut.error as Error).message}
                </span>
              )}
              {!updateMut.isPending && !updateMut.isSuccess && !updateMut.error && (
                <span className="muted">
                  Autosaves as you type · {(current.html?.length ?? 0).toLocaleString()} chars on server
                </span>
              )}
            </div>
            <div className="row gap-sm">
              <button
                className="btn btn-sm"
                style={{ color: 'var(--bad)' }}
                onClick={() => {
                  if (confirm(`Delete "${current.title}"?`)) deleteMut.mutate(current.id);
                }}
                disabled={deleteMut.isPending}
              >
                Delete
              </button>
              <button
                className="btn btn-sm"
                onClick={() => setPreviewOpen(true)}
                disabled={!localHtml.trim()}
                title="See the email exactly as it will render, including the footer"
              >
                Preview rendered email
              </button>
              <button
                className="btn btn-sm"
                onClick={() => testSendMut.mutate()}
                disabled={testSendMut.isPending}
                title="Email the current draft to yourself for review"
              >
                {testSendMut.isPending
                  ? 'Sending…'
                  : testSendMut.isSuccess
                    ? `Sent to ${testSendMut.data?.to ?? 'you'} ✓`
                    : 'Send to yourself'}
              </button>
              <button
                className="btn btn-sm btn-primary"
                onClick={() => {
                  if (current.id) {
                    window.localStorage.setItem(SEND_PRESELECT_KEY, current.id);
                  }
                  navigate({ to: '/send' });
                }}
              >
                Continue to Send →
              </button>
            </div>
          </div>
          {testSendMut.error && (
            <div style={{ color: 'var(--bad)', fontSize: 12, paddingTop: 4 }}>
              Test send failed: {(testSendMut.error as Error).message}
            </div>
          )}
        </div>
      ) : (
        <div className="muted" style={{ padding: 40, textAlign: 'center' }}>
          Create a newsletter on the left to get started.
        </div>
      )}
    </div>
    {imagePickerOpen && (
      <AssetPickerModal
        onClose={() => setImagePickerOpen(false)}
        onSelect={handleAssetSelect}
      />
    )}
    {previewOpen && (
      <RenderedPreviewModal
        html={localHtml}
        subject={localSubject}
        title={localTitle}
        settings={settings}
        onClose={() => setPreviewOpen(false)}
      />
    )}
    </>
  );
}

function NewTypePicker({
  types,
  defaultTypeId,
  onPick,
  onCancel,
  pending,
}: {
  types: NewsletterType[];
  defaultTypeId: string;
  onPick: (typeId: string) => void;
  onCancel: () => void;
  pending: boolean;
}) {
  const [chosen, setChosen] = useState<string>(defaultTypeId || types[0]?.id || '');
  return (
    <div
      style={{
        marginTop: 10,
        padding: 10,
        background: 'var(--paper-deep)',
        border: '1px solid var(--rule)',
        borderRadius: 6,
      }}
    >
      <div className="label" style={{ marginBottom: 6 }}>Newsletter type</div>
      <div className="stack" style={{ gap: 4, marginBottom: 10 }}>
        {types.map((t) => (
          <label key={t.id} className="row items-center gap-sm" style={{ fontSize: 12, cursor: 'pointer' }}>
            <input
              type="radio"
              name="new-type"
              value={t.id}
              checked={chosen === t.id}
              onChange={() => setChosen(t.id)}
            />
            <TypePill type={t} />
            <span className="muted" style={{ fontSize: 11 }}>
              {t.description ?? ''}
            </span>
          </label>
        ))}
      </div>
      <div className="row gap-sm" style={{ justifyContent: 'flex-end' }}>
        <button className="btn btn-sm" onClick={onCancel} disabled={pending}>
          Cancel
        </button>
        <button
          className="btn btn-sm btn-primary"
          onClick={() => chosen && onPick(chosen)}
          disabled={pending || !chosen}
        >
          {pending ? 'Creating…' : 'Create'}
        </button>
      </div>
    </div>
  );
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function RenderedPreviewModal({
  html,
  subject,
  title,
  settings,
  onClose,
}: {
  html: string;
  subject: string;
  title: string;
  settings: OrgSettings | undefined;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const footer = renderFooterPreviewHtml({
    footerHtml: settings?.footerHtml ?? '',
    senderName: settings?.senderName,
    senderAddress: settings?.senderAddress,
    unsubUrl: 'https://example.com/u?c=preview&e=you%40example.com&t=preview',
  });
  const doc = buildPreviewSrcDoc(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<style>
  body { margin: 0; background: #f3f4f6; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  .preview-shell { max-width: 640px; margin: 24px auto; background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden; }
  .preview-body { padding: 24px; }
</style>
</head>
<body>
<div class="preview-shell"><div class="preview-body">${html}${footer}</div></div>
</body>
</html>`);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal modal-lg"
        onClick={(e) => e.stopPropagation()}
        style={{ width: '92vw', maxWidth: 1000, height: '90vh', display: 'flex', flexDirection: 'column' }}
      >
        <div className="modal-header">
          <div className="eyebrow">Email preview</div>
          <h2 className="serif" style={{ fontSize: 18, marginTop: 4 }}>
            {subject || title || '(no subject)'}
          </h2>
          <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            Unsubscribe link is a placeholder. The footer is appended automatically on real sends.
          </p>
        </div>
        <div className="modal-body" style={{ flex: 1, padding: '8px 16px 16px' }}>
          <iframe
            title="email-preview"
            srcDoc={doc}
            sandbox=""
            style={{
              width: '100%',
              height: '100%',
              border: '1px solid var(--rule)',
              borderRadius: 6,
              background: 'var(--paper)',
            }}
          />
        </div>
        <div className="modal-footer" style={{ justifyContent: 'flex-end' }}>
          <button className="btn btn-sm" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
