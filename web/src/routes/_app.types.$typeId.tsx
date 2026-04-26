import { createFileRoute, useNavigate, useParams, Link } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useEditor, EditorContent, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import LinkExt from '@tiptap/extension-link';
import Image from '@tiptap/extension-image';
import {
  createType,
  getType,
  updateType,
  type NewsletterType,
} from '../api/endpoints';
import { TypePill } from '../components/types/TypePill';

export const Route = createFileRoute('/_app/types/$typeId')({
  component: TypeEditPage,
});

const TAG_RE = /^[a-z0-9-]{1,40}$/;

function TypeEditPage() {
  const { typeId } = useParams({ from: '/_app/types/$typeId' });
  const isNew = typeId === 'new';
  const navigate = useNavigate();
  const qc = useQueryClient();

  const { data: existing, isLoading, error: loadErr } = useQuery({
    queryKey: ['type', typeId],
    queryFn: () => getType(typeId),
    enabled: !isNew,
  });

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [color, setColor] = useState<number>(200);
  const [defaultTagsRaw, setDefaultTagsRaw] = useState('');
  const [defaultSubjectPrefix, setDefaultSubjectPrefix] = useState('');
  const [defaultBodyHtml, setDefaultBodyHtml] = useState('');
  const [tagWarning, setTagWarning] = useState<string | null>(null);
  const [editorMode, setEditorMode] = useState<'visual' | 'code'>('visual');
  const seededRef = useRef(false);

  const editor = useEditor({
    extensions: [
      StarterKit,
      LinkExt.configure({ openOnClick: false, autolink: true }),
      Image,
    ],
    content: '',
    onUpdate: ({ editor }) => setDefaultBodyHtml(editor.getHTML()),
  });

  // Seed once when data arrives (or immediately if creating).
  useEffect(() => {
    if (seededRef.current || !editor) return;
    if (!isNew && !existing) return;
    seededRef.current = true;
    if (existing) {
      setName(existing.name);
      setDescription(existing.description ?? '');
      setColor(existing.color);
      setDefaultTagsRaw(existing.defaultTags.join(', '));
      setDefaultSubjectPrefix(existing.defaultSubjectPrefix ?? '');
      setDefaultBodyHtml(existing.defaultBodyHtml ?? '');
      editor.commands.setContent(existing.defaultBodyHtml || '<p></p>', { emitUpdate: false });
    }
  }, [editor, existing, isNew]);

  // Reseed when switching back into visual mode.
  useEffect(() => {
    if (!editor || editorMode !== 'visual') return;
    if (editor.getHTML() === defaultBodyHtml) return;
    editor.commands.setContent(defaultBodyHtml || '<p></p>', { emitUpdate: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorMode]);

  const saveMut = useMutation({
    mutationFn: (input: Partial<NewsletterType>) =>
      isNew ? createType(input) : updateType(typeId, input),
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ['types'] });
      qc.setQueryData(['type', saved.id], saved);
      navigate({ to: '/types' });
    },
  });

  function onSave() {
    setTagWarning(null);
    const tags = defaultTagsRaw
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
    const bad = tags.find((t) => !TAG_RE.test(t));
    if (bad) {
      setTagWarning(`Invalid tag: "${bad}" — use lowercase letters, digits, and dashes only.`);
      return;
    }
    const cleanedHtml = defaultBodyHtml === '<p></p>' ? '' : defaultBodyHtml;
    saveMut.mutate({
      name: name.trim(),
      description: description.trim() || undefined,
      color,
      defaultTags: tags,
      defaultSubjectPrefix: defaultSubjectPrefix.trim() || undefined,
      defaultBodyHtml: cleanedHtml || undefined,
    });
  }

  if (!isNew && isLoading) {
    return <p className="muted" style={{ padding: 16 }}>Loading…</p>;
  }
  if (!isNew && loadErr) {
    return (
      <div className="card">
        <div className="card-body">
          <p style={{ color: 'var(--bad)' }}>
            Failed to load type: {(loadErr as Error).message}
          </p>
          <Link to="/types" className="btn btn-sm" style={{ marginTop: 12 }}>← Back to types</Link>
        </div>
      </div>
    );
  }

  const saving = saveMut.isPending;
  const saveErr = saveMut.error as Error | undefined;

  return (
    <div className="stack" style={{ gap: 16, maxWidth: 920 }}>
      <div className="row items-center justify-between">
        <Link to="/types" className="btn btn-sm">← Back to types</Link>
        <div className="row gap-sm">
          <button className="btn btn-sm" onClick={() => navigate({ to: '/types' })} disabled={saving}>
            Cancel
          </button>
          <button
            className="btn btn-sm btn-primary"
            disabled={saving || !name.trim()}
            onClick={onSave}
          >
            {saving ? 'Saving…' : isNew ? 'Create type' : 'Save'}
          </button>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <div>
            <div className="eyebrow">Workspace</div>
            <h3 className="serif mt-sm">{isNew ? 'New type' : `Edit "${existing?.name ?? ''}"`}</h3>
            <p className="muted" style={{ fontSize: 13, marginTop: 4 }}>
              Defaults defined here are applied when composing a new newsletter of this type.
            </p>
          </div>
        </div>
        <div className="card-body stack" style={{ gap: 16 }}>
          <div className="grid grid-2" style={{ gap: 14 }}>
            <div>
              <div className="label">Name</div>
              <input
                className="input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Quarterly Newsletter"
                style={{ fontFamily: 'var(--serif)', fontSize: 15, padding: '8px 10px' }}
              />
            </div>
            <div>
              <div className="label">Color</div>
              <div className="row items-center gap-md">
                <input
                  type="range"
                  min={0}
                  max={360}
                  value={color}
                  onChange={(e) => setColor(Number(e.target.value))}
                  style={{ flex: 1 }}
                />
                <TypePill
                  type={{
                    id: 'preview',
                    name: name || 'Preview',
                    color,
                    defaultTags: [],
                    createdAt: '',
                  }}
                />
              </div>
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <div className="label">Description (optional)</div>
              <input
                className="input"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="One line that helps editors pick the right type"
                style={{ fontSize: 13, padding: '8px 10px' }}
              />
            </div>
            <div>
              <div className="label">Default subject prefix</div>
              <input
                className="input"
                value={defaultSubjectPrefix}
                onChange={(e) => setDefaultSubjectPrefix(e.target.value)}
                placeholder="[Quarterly] "
                style={{ fontFamily: 'var(--mono)', fontSize: 13, padding: '8px 10px' }}
              />
            </div>
            <div>
              <div className="label">Default audience tags (comma-separated)</div>
              <input
                className="input"
                value={defaultTagsRaw}
                onChange={(e) => {
                  setDefaultTagsRaw(e.target.value);
                  setTagWarning(null);
                }}
                placeholder="donors, board"
                style={{ fontFamily: 'var(--mono)', fontSize: 13, padding: '8px 10px' }}
              />
              {tagWarning && (
                <div style={{ color: 'var(--bad)', fontSize: 11, marginTop: 4 }}>{tagWarning}</div>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <div>
            <div className="eyebrow">Default body</div>
            <h3 className="serif mt-sm">Newsletter template</h3>
            <p className="muted" style={{ fontSize: 13, marginTop: 4 }}>
              When someone composes a new newsletter of this type, this HTML is used as the
              starting body. Leave blank to fall back to the system default.
            </p>
          </div>
          <div className="editor-mode-toggle" role="tablist" aria-label="Editor mode">
            <button
              type="button"
              role="tab"
              aria-selected={editorMode === 'visual'}
              className={`editor-mode-btn ${editorMode === 'visual' ? 'active' : ''}`}
              onClick={() => setEditorMode('visual')}
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
        </div>
        <div className="card-body stack" style={{ gap: 8 }}>
          {editorMode === 'visual' ? (
            <>
              <Toolbar editor={editor} />
              <div
                className="wysiwyg-editor"
                style={{
                  minHeight: 320,
                  height: 'auto',
                  border: '1px solid var(--rule, #e5e7eb)',
                  borderRadius: 6,
                }}
              >
                <EditorContent editor={editor} />
              </div>
            </>
          ) : (
            <textarea
              className="code-editor"
              value={defaultBodyHtml}
              onChange={(e) => setDefaultBodyHtml(e.target.value)}
              spellCheck={false}
              style={{ minHeight: 320 }}
            />
          )}
        </div>
      </div>

      {saveErr && (
        <div className="card">
          <div className="card-body" style={{ color: 'var(--bad)', fontSize: 13 }}>
            {saveErr.message}
          </div>
        </div>
      )}
    </div>
  );
}

function Toolbar({ editor }: { editor: Editor | null }) {
  if (!editor) return null;
  return (
    <div className="row items-center gap-sm" style={{ flexWrap: 'wrap' }}>
      <ToolbarButton onClick={() => editor.chain().focus().toggleBold().run()} active={editor.isActive('bold')}>B</ToolbarButton>
      <ToolbarButton onClick={() => editor.chain().focus().toggleItalic().run()} active={editor.isActive('italic')}><i>I</i></ToolbarButton>
      <ToolbarButton onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} active={editor.isActive('heading', { level: 2 })}>H2</ToolbarButton>
      <ToolbarButton onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()} active={editor.isActive('heading', { level: 3 })}>H3</ToolbarButton>
      <ToolbarButton onClick={() => editor.chain().focus().toggleBulletList().run()} active={editor.isActive('bulletList')}>• List</ToolbarButton>
      <ToolbarButton onClick={() => {
        const prev = editor.getAttributes('link').href as string | undefined;
        const url = window.prompt('URL', prev ?? 'https://');
        if (url === null) return;
        if (url === '') {
          editor.chain().focus().extendMarkRange('link').unsetLink().run();
        } else {
          editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
        }
      }} active={editor.isActive('link')}>Link</ToolbarButton>
    </div>
  );
}

function ToolbarButton({
  children,
  onClick,
  active,
}: {
  children: React.ReactNode;
  onClick: () => void;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`btn btn-sm ${active ? 'btn-primary' : 'btn-ghost'}`}
      style={{ minWidth: 32 }}
    >
      {children}
    </button>
  );
}

