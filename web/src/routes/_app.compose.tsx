import { createFileRoute } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useEditor, EditorContent, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Image from '@tiptap/extension-image';
import TextAlign from '@tiptap/extension-text-align';
import {
  createTemplate,
  deleteTemplate,
  listTemplates,
  updateTemplate,
  type Asset,
  type Template,
} from '../api/endpoints';
import { AssetPickerModal } from '../components/AssetPickerModal';

export const Route = createFileRoute('/_app/compose')({
  component: ComposePage,
});

const LIST_COLLAPSE_KEY = 'dispatch.compose.list.collapsed';
const ASSET_BASE_KEY = 'dispatch.compose.assetBase';
const EDITOR_MODE_KEY = 'dispatch.compose.editorMode';

type EditorMode = 'visual' | 'code';

const DEFAULT_HTML = `<!doctype html>
<html><body style="font-family:Georgia,serif;max-width:600px;margin:0 auto;padding:32px">
  <h1>Your newsletter</h1>
  <p>Start composing here.</p>
</body></html>`;

function ComposePage() {
  const qc = useQueryClient();
  const { data: templates = [], isLoading, error } = useQuery({
    queryKey: ['templates'],
    queryFn: async () => {
      const t = await listTemplates();
      console.log('[templates] loaded', t);
      return t;
    },
  });

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

  // Snapshot of the original (pre-WYSIWYG) HTML, captured the first time the
  // user enters Visual mode for a given template. Lets us offer a "Restore
  // HTML" button if TipTap's HTML normalization has lost meaningful detail.
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
    mutationFn: () =>
      createTemplate({
        title: 'Untitled newsletter',
        subject: '',
        html: DEFAULT_HTML,
        targetTags: [],
      }),
    onSuccess: (t) => {
      qc.setQueryData<Template[]>(['templates'], (old) => [t, ...(old ?? [])]);
      setCurrentId(t.id);
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

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [imagePickerOpen, setImagePickerOpen] = useState(false);

  const [localHtml, setLocalHtml] = useState(current?.html ?? '');
  const [localSubject, setLocalSubject] = useState(current?.subject ?? '');
  const [localTitle, setLocalTitle] = useState(current?.title ?? '');

  // TipTap editor — single instance reused across mode switches. `onUpdate`
  // pumps the editor's current HTML into `localHtml`, which the existing
  // 750ms autosave effect already watches.
  const editor = useEditor({
    extensions: [
      StarterKit,
      Link.configure({ openOnClick: false, autolink: true }),
      Image,
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
    ],
    content: localHtml,
    onUpdate: ({ editor }) => {
      const html = editor.getHTML();
      setLocalHtml(html);
    },
  });

  // Reset on template switch: pull fresh content into local state AND reseed
  // the WYSIWYG editor in the SAME effect. Doing the editor reseed here
  // (rather than in a separate effect keyed on current?.id) avoids a closure
  // trap: a separate effect would see the stale `localHtml` from this
  // render's closure (still equal to editor.getHTML() since neither has been
  // updated yet for the new template), bail out of the equality check, and
  // leave the editor showing the *previous* template's content. The next
  // keystroke would then push the previous template's HTML into `localHtml`
  // and the iframe preview would render the wrong newsletter.
  useEffect(() => {
    console.log('[reset-local]', { id: current?.id, htmlLen: current?.html?.length });
    const newHtml = current?.html ?? '';
    setLocalHtml(newHtml);
    setLocalSubject(current?.subject ?? '');
    setLocalTitle(current?.title ?? '');
    originalHtmlRef.current = null;
    if (editor && editorMode === 'visual') {
      // Snapshot the new template's original HTML before TipTap normalizes
      // it, so the user can still hit "Restore HTML" later.
      originalHtmlRef.current = newHtml;
      editor.commands.setContent(newHtml || '<p></p>', { emitUpdate: false });
    }
    // Intentionally NOT depending on editorMode — switching modes is handled
    // by the next effect. Depending on `editor` so the initial seed runs
    // once the editor instance becomes available after first render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id, editor]);

  // Reseed when entering visual mode (preserves uncommitted code-mode edits
  // that haven't yet flushed through the 750ms autosave debounce). This is
  // the ONLY effect that handles mode switches; template switches are
  // handled atomically by the reset effect above.
  useEffect(() => {
    if (!editor) return;
    if (editorMode !== 'visual') return;
    if (editor.getHTML() === localHtml) return;
    editor.commands.setContent(localHtml || '<p></p>', { emitUpdate: false });
    // Only re-run when the mode itself changes. Depending on `localHtml`
    // would clobber the cursor on every keystroke; depending on `current?.id`
    // would race with the reset effect above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorMode]);

  // Switch into visual mode. If the user has hand-coded HTML that TipTap may
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
    if (editor) {
      editor.commands.setContent(original || '<p></p>', { emitUpdate: false });
    }
    originalHtmlRef.current = null;
  }

  const canRestore = editorMode === 'code' && originalHtmlRef.current !== null && originalHtmlRef.current !== localHtml;

  // Insert a chosen asset into whichever editor is active. In Visual mode we
  // hand off to TipTap's setImage command so the node sits inside the
  // ProseMirror doc (autosave then picks it up via onUpdate). In Code mode
  // we splice raw <img> markup at the textarea's caret — preserves the
  // surrounding HTML structure the user is hand-editing.
  function handleAssetSelect(asset: Asset) {
    setImagePickerOpen(false);
    const alt = asset.filename.replace(/\.[a-z0-9]+$/i, '').replace(/-/g, ' ');
    if (editorMode === 'visual') {
      editor?.chain().focus().setImage({ src: asset.url, alt }).run();
      return;
    }
    const tag = `<img src="${asset.url}" alt="${escapeAttr(alt)}" style="max-width:100%;height:auto" />`;
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

  // Live preview: render whatever's currently in the editor (not just the
  // last saved version) so typing in the textarea is instantly reflected
  // in the iframe. If the user set an Asset base URL, inject a <base href>
  // so relative <img>/<a> URLs in the source HTML resolve to the original
  // host instead of dispatch.scienthouse.io (which 403s for /system/images
  // and other paths it doesn't own).
  useEffect(() => {
    const doc = iframeRef.current?.contentDocument;
    if (!doc) return;
    let html = localHtml || '<!doctype html><html><body></body></html>';
    if (assetBase) {
      const baseTag = `<base href="${assetBase.replace(/"/g, '&quot;')}">`;
      if (/<head[^>]*>/i.test(html)) {
        html = html.replace(/<head[^>]*>/i, (m) => `${m}${baseTag}`);
      } else {
        html = `${baseTag}${html}`;
      }
    }
    doc.open();
    doc.write(html);
    doc.close();
  }, [localHtml, assetBase, current?.id]);

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
                  console.log('[compose] + New newsletter clicked; firing mutate…');
                  createMut.mutate();
                }}
                disabled={createMut.isPending}
              >
                {createMut.isPending ? 'Creating…' : '+ New newsletter'}
              </button>
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
                    <div className="muted" style={{ fontSize: 10, marginTop: 6, fontFamily: 'var(--mono)' }}>
                      v{t.version} · {new Date(t.updatedAt).toLocaleDateString()}
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
              <div style={{ marginBottom: 12 }}>
                <div className="label">Newsletter title (internal)</div>
                <input
                  className="input"
                  value={localTitle}
                  onChange={(e) => setLocalTitle(e.target.value)}
                  style={{ fontFamily: 'var(--serif)', fontSize: 16, padding: '10px 12px' }}
                />
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

          <div className="split" style={{ gridTemplateColumns: '1fr 1fr', gridTemplateRows: '1fr' }}>
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
              {editorMode === 'visual' && editor && (
                <WysiwygToolbar editor={editor} onPickImage={() => setImagePickerOpen(true)} />
              )}
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
                  <EditorContent editor={editor} className="wysiwyg-editor" />
                )}
              </div>
            </div>
            <div className="split-pane">
              <div className="split-pane-header" style={{ gap: 8 }}>
                <span className="mono-sm">Preview</span>
                <input
                  className="input"
                  value={assetBase}
                  onChange={(e) => setAssetBase(e.target.value)}
                  placeholder="Asset base URL (e.g. https://nimhda.org)"
                  title="Resolves relative <img>/<a> URLs in the preview. Saved per-browser."
                  style={{ flex: 1, fontSize: 11, padding: '4px 8px', fontFamily: 'var(--mono)' }}
                />
              </div>
              <div className="split-pane-body preview-shell">
                <iframe ref={iframeRef} className="preview-page" style={{ border: 'none' }} title="preview" />
              </div>
            </div>
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
            </div>
          </div>
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
    </>
  );
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function WysiwygToolbar({ editor, onPickImage }: { editor: Editor; onPickImage: () => void }) {
  // Force re-render when the editor's selection or active marks change so the
  // active state on toolbar buttons stays in sync.
  const [, force] = useState(0);
  useEffect(() => {
    const update = () => force((n) => n + 1);
    editor.on('selectionUpdate', update);
    editor.on('transaction', update);
    return () => {
      editor.off('selectionUpdate', update);
      editor.off('transaction', update);
    };
  }, [editor]);

  const btn = (
    label: string,
    isActive: boolean,
    onClick: () => void,
    title: string,
  ) => (
    <button
      type="button"
      className={`tb-btn ${isActive ? 'active' : ''}`}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      title={title}
    >
      {label}
    </button>
  );

  const promptLink = () => {
    const prev = editor.getAttributes('link').href as string | undefined;
    const url = window.prompt('Link URL (leave blank to remove)', prev ?? 'https://');
    if (url === null) return;
    if (url === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }
    editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
  };


  return (
    <div className="wysiwyg-toolbar">
      {btn('B', editor.isActive('bold'), () => editor.chain().focus().toggleBold().run(), 'Bold (⌘B)')}
      {btn('I', editor.isActive('italic'), () => editor.chain().focus().toggleItalic().run(), 'Italic (⌘I)')}
      {btn('S', editor.isActive('strike'), () => editor.chain().focus().toggleStrike().run(), 'Strikethrough')}
      <span className="tb-divider" />
      {btn('H1', editor.isActive('heading', { level: 1 }), () => editor.chain().focus().toggleHeading({ level: 1 }).run(), 'Heading 1')}
      {btn('H2', editor.isActive('heading', { level: 2 }), () => editor.chain().focus().toggleHeading({ level: 2 }).run(), 'Heading 2')}
      {btn('H3', editor.isActive('heading', { level: 3 }), () => editor.chain().focus().toggleHeading({ level: 3 }).run(), 'Heading 3')}
      {btn('¶', editor.isActive('paragraph'), () => editor.chain().focus().setParagraph().run(), 'Paragraph')}
      <span className="tb-divider" />
      {btn('•', editor.isActive('bulletList'), () => editor.chain().focus().toggleBulletList().run(), 'Bullet list')}
      {btn('1.', editor.isActive('orderedList'), () => editor.chain().focus().toggleOrderedList().run(), 'Numbered list')}
      {btn('“”', editor.isActive('blockquote'), () => editor.chain().focus().toggleBlockquote().run(), 'Blockquote')}
      {btn('</>', editor.isActive('codeBlock'), () => editor.chain().focus().toggleCodeBlock().run(), 'Code block')}
      <span className="tb-divider" />
      {btn('⇤', editor.isActive({ textAlign: 'left' }), () => editor.chain().focus().setTextAlign('left').run(), 'Align left')}
      {btn('⇔', editor.isActive({ textAlign: 'center' }), () => editor.chain().focus().setTextAlign('center').run(), 'Align center')}
      {btn('⇥', editor.isActive({ textAlign: 'right' }), () => editor.chain().focus().setTextAlign('right').run(), 'Align right')}
      <span className="tb-divider" />
      {btn('🔗', editor.isActive('link'), promptLink, 'Add or edit link')}
      {btn('🖼', false, onPickImage, 'Insert image from library')}
      {btn('—', false, () => editor.chain().focus().setHorizontalRule().run(), 'Horizontal rule')}
      <span className="tb-divider" />
      {btn('↶', false, () => editor.chain().focus().undo().run(), 'Undo (⌘Z)')}
      {btn('↷', false, () => editor.chain().focus().redo().run(), 'Redo (⇧⌘Z)')}
    </div>
  );
}
