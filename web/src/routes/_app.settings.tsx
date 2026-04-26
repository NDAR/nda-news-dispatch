import { createFileRoute } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useEditor, EditorContent, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import { getSettings, updateSettings, type OrgSettings } from '../api/endpoints';
import { renderFooterPreviewHtml } from '../lib/footerPreview';

export const Route = createFileRoute('/_app/settings')({
  component: SettingsPage,
});

function SettingsPage() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ['settings'],
    queryFn: getSettings,
  });

  const [footerHtml, setFooterHtml] = useState('');
  const [senderName, setSenderName] = useState('');
  const [senderAddress, setSenderAddress] = useState('');
  const [showPreview, setShowPreview] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const seededRef = useRef(false);

  const editor = useEditor({
    extensions: [StarterKit, Link.configure({ openOnClick: false, autolink: true })],
    content: '',
    onUpdate: ({ editor }) => setFooterHtml(editor.getHTML()),
  });

  // One-shot seed once data loads. Subsequent renders preserve user edits.
  useEffect(() => {
    if (seededRef.current || !data || !editor) return;
    seededRef.current = true;
    setFooterHtml(data.footerHtml ?? '');
    setSenderName(data.senderName ?? '');
    setSenderAddress(data.senderAddress ?? '');
    editor.commands.setContent(data.footerHtml || '<p></p>', { emitUpdate: false });
  }, [data, editor]);

  const saveMut = useMutation({
    mutationFn: (input: Partial<OrgSettings>) => updateSettings(input),
    onSuccess: (saved) => {
      qc.setQueryData(['settings'], saved);
      setSaveError(null);
    },
    onError: (e: unknown) => {
      const msg = e instanceof Error ? e.message : 'Failed to save';
      setSaveError(msg);
    },
  });

  function onSave() {
    setSaveError(null);
    saveMut.mutate({
      footerHtml: footerHtml === '<p></p>' ? '' : footerHtml,
      senderName: senderName.trim() || undefined,
      senderAddress: senderAddress.trim() || undefined,
    });
  }

  const dirty =
    !!data &&
    ((data.footerHtml ?? '') !== (footerHtml === '<p></p>' ? '' : footerHtml) ||
      (data.senderName ?? '') !== senderName ||
      (data.senderAddress ?? '') !== senderAddress);

  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="card">
        <div className="card-header">
          <div>
            <div className="eyebrow">Workspace</div>
            <h3 className="serif mt-sm">Email footer</h3>
            <p className="muted" style={{ marginTop: 4, fontSize: 13 }}>
              This footer is appended to every campaign and test send. The unsubscribe link and
              your mailing address are added automatically — you don't need to include them in the
              footer body.
            </p>
          </div>
          <div className="row items-center gap-sm">
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => setShowPreview((v) => !v)}
              type="button"
            >
              {showPreview ? 'Hide preview' : 'Preview email'}
            </button>
            <button
              className="btn btn-primary btn-sm"
              onClick={onSave}
              disabled={!dirty || saveMut.isPending}
              type="button"
            >
              {saveMut.isPending ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>

        <div className="card-body stack" style={{ gap: 16 }}>
          {isLoading && <p className="muted">Loading…</p>}
          {error && (
            <p className="muted" style={{ color: 'var(--danger, #b91c1c)' }}>
              Failed to load settings: {error instanceof Error ? error.message : String(error)}
            </p>
          )}
          {saveError && (
            <p className="muted" style={{ color: 'var(--danger, #b91c1c)' }}>
              {saveError}
            </p>
          )}

          <div className="stack" style={{ gap: 6 }}>
            <label className="eyebrow">Sender name</label>
            <input
              type="text"
              value={senderName}
              onChange={(e) => setSenderName(e.target.value)}
              placeholder="e.g. Scienthouse Dispatch"
              maxLength={120}
              className="input"
            />
          </div>

          <div className="stack" style={{ gap: 6 }}>
            <label className="eyebrow">Sender mailing address</label>
            <textarea
              value={senderAddress}
              onChange={(e) => setSenderAddress(e.target.value)}
              placeholder={'123 Main St\nSuite 100\nSan Francisco, CA 94105'}
              rows={3}
              maxLength={500}
              className="input"
              style={{ resize: 'vertical', fontFamily: 'inherit' }}
            />
            <p className="muted" style={{ fontSize: 12 }}>
              Required for CAN-SPAM compliance. Appears at the bottom of every email above the
              unsubscribe link.
            </p>
          </div>

          <div className="stack" style={{ gap: 6 }}>
            <label className="eyebrow">Footer body (optional)</label>
            <FooterToolbar editor={editor} />
            <div
              className="wysiwyg-editor"
              style={{
                minHeight: 160,
                height: 'auto',
                border: '1px solid var(--rule, #e5e7eb)',
                borderRadius: 6,
              }}
            >
              <EditorContent editor={editor} />
            </div>
            <p className="muted" style={{ fontSize: 12 }}>
              Brand text, social links, etc. Leave empty if you only need the address +
              unsubscribe.
            </p>
          </div>

          {showPreview && (
            <PreviewPanel
              footerHtml={footerHtml === '<p></p>' ? '' : footerHtml}
              senderName={senderName}
              senderAddress={senderAddress}
            />
          )}

          {data?.updatedAt && (
            <p className="muted" style={{ fontSize: 12 }}>
              Last updated {new Date(data.updatedAt).toLocaleString()}
              {data.updatedBy ? ` by ${data.updatedBy}` : ''}.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function FooterToolbar({ editor }: { editor: Editor | null }) {
  if (!editor) return null;
  return (
    <div className="row items-center gap-sm" style={{ flexWrap: 'wrap' }}>
      <ToolbarButton onClick={() => editor.chain().focus().toggleBold().run()} active={editor.isActive('bold')}>B</ToolbarButton>
      <ToolbarButton onClick={() => editor.chain().focus().toggleItalic().run()} active={editor.isActive('italic')}><i>I</i></ToolbarButton>
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
      <ToolbarButton onClick={() => editor.chain().focus().toggleBulletList().run()} active={editor.isActive('bulletList')}>• List</ToolbarButton>
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

function PreviewPanel({
  footerHtml,
  senderName,
  senderAddress,
}: {
  footerHtml: string;
  senderName: string;
  senderAddress: string;
}) {
  const sample = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;font-size:14px;color:#111;line-height:1.55;padding:24px;max-width:600px;margin:0 auto;">
      <h2 style="margin:0 0 12px;">Sample newsletter</h2>
      <p>This is what the body of your campaign would look like. The footer below is appended automatically on every send.</p>
    </div>
  `;
  const footer = renderFooterPreview(footerHtml, senderName, senderAddress);
  const html = `<!doctype html><html><body style="margin:0;background:#f9fafb;">${sample}${footer}</body></html>`;
  return (
    <div className="stack" style={{ gap: 6 }}>
      <label className="eyebrow">Preview</label>
      <iframe
        title="Footer preview"
        srcDoc={html}
        style={{
          width: '100%',
          height: 380,
          border: '1px solid var(--rule, #e5e7eb)',
          borderRadius: 6,
          background: '#fff',
        }}
      />
    </div>
  );
}

function renderFooterPreview(
  footerHtml: string,
  senderName: string,
  senderAddress: string,
): string {
  const inner = renderFooterPreviewHtml({
    footerHtml,
    senderName,
    senderAddress,
    unsubUrl: 'https://example.com/u?c=preview&e=you%40example.com&t=preview',
  });
  return `<div style="max-width:600px;margin:0 auto;padding:0 24px 24px;">${inner}</div>`;
}
