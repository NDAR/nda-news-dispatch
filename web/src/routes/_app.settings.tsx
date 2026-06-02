import { createFileRoute } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { RichHtmlEditor, normalizeEmptyRichHtml } from '../components/RichHtmlEditor';
import { getSettings, listTypes, updateSettings, type OrgSettings } from '../api/endpoints';
import { renderFooterPreviewHtml } from '../lib/footerPreview';
import { buildPreviewSrcDoc } from '../lib/previewFrame';

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
  const [fromName, setFromName] = useState('');
  const [fromLocalPart, setFromLocalPart] = useState('');
  const [replyTo, setReplyTo] = useState('');
  const [showPreview, setShowPreview] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const seededRef = useRef(false);

  const sendingDomain = data?.sendingDomain ?? '';

  // One-shot seed once data loads. Subsequent renders preserve user edits.
  useEffect(() => {
    if (seededRef.current || !data) return;
    seededRef.current = true;
    setFooterHtml(data.footerHtml ?? '');
    setSenderName(data.senderName ?? '');
    setSenderAddress(data.senderAddress ?? '');
    setFromName(data.fromName ?? '');
    setFromLocalPart(data.fromLocalPart ?? '');
    setReplyTo(data.replyTo ?? '');
  }, [data]);

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
    const normalizedFooterHtml = normalizeEmptyRichHtml(footerHtml);
    saveMut.mutate({
      footerHtml: normalizedFooterHtml,
      senderName: senderName.trim() || undefined,
      senderAddress: senderAddress.trim() || undefined,
      fromName: fromName.trim() || undefined,
      fromLocalPart: fromLocalPart.trim().toLowerCase() || undefined,
      replyTo: replyTo.trim().toLowerCase() || undefined,
    });
  }

  const dirty =
    !!data &&
    ((data.footerHtml ?? '') !== normalizeEmptyRichHtml(footerHtml) ||
      (data.senderName ?? '') !== senderName ||
      (data.senderAddress ?? '') !== senderAddress ||
      (data.fromName ?? '') !== fromName ||
      (data.fromLocalPart ?? '') !== fromLocalPart ||
      (data.replyTo ?? '') !== replyTo);

  return (
    <div className="stack" style={{ gap: 20 }}>
      {/* Page-level header. The Save button governs *both* the Sender
          identity card and the Email footer card below — they're sections
          of one settings record. Visually anchoring Save at the page
          level (rather than inside one of the cards) makes the shared
          scope obvious. */}
      <div
        className="row items-center justify-between"
        style={{ gap: 16, flexWrap: 'wrap' }}
      >
        <div>
          <div className="eyebrow">Workspace</div>
          <h2 className="serif mt-sm" style={{ fontSize: 20 }}>Email settings</h2>
          <p className="muted" style={{ fontSize: 13, marginTop: 4 }}>
            Sender identity and footer that apply to every outbound newsletter.
          </p>
        </div>
        <div className="row items-center gap-sm">
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

      {error && (
        <p className="muted" style={{ color: 'var(--danger, #b91c1c)', fontSize: 13 }}>
          Failed to load settings: {error instanceof Error ? error.message : String(error)}
        </p>
      )}
      {saveError && (
        <p className="muted" style={{ color: 'var(--danger, #b91c1c)', fontSize: 13 }}>
          {saveError}
        </p>
      )}

      <SenderIdentityCard
        fromName={fromName}
        setFromName={setFromName}
        fromLocalPart={fromLocalPart}
        setFromLocalPart={setFromLocalPart}
        replyTo={replyTo}
        setReplyTo={setReplyTo}
        sendingDomain={sendingDomain}
        loading={isLoading}
      />

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
        </div>

        <div className="card-body stack" style={{ gap: 16 }}>
          {isLoading && <p className="muted">Loading…</p>}

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
            <RichHtmlEditor
              value={footerHtml}
              onChange={setFooterHtml}
              minHeight={180}
            />
            <p className="muted" style={{ fontSize: 12 }}>
              Brand text, social links, etc. Leave empty if you only need the address +
              unsubscribe.
            </p>
            <div style={{ marginTop: 4 }}>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => setShowPreview((v) => !v)}
                type="button"
              >
                {showPreview ? 'Hide preview' : 'Preview email'}
              </button>
            </div>
          </div>

          {showPreview && (
            <PreviewPanel
              footerHtml={normalizeEmptyRichHtml(footerHtml)}
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

      <SubscribeLinksCard />
    </div>
  );
}

/**
 * Org-wide sender-identity card. Persists via the same Settings PUT as the
 * footer below — the page-level dirty flag and `onSave` already cover all
 * fields, so we don't render a separate save button here.
 *
 * The local-part field has an inline `@<sendingDomain>` suffix rendered as
 * static text so users understand the domain is fixed by the SES
 * verification, not editable.
 */
function SenderIdentityCard({
  fromName,
  setFromName,
  fromLocalPart,
  setFromLocalPart,
  replyTo,
  setReplyTo,
  sendingDomain,
  loading,
}: {
  fromName: string;
  setFromName: (s: string) => void;
  fromLocalPart: string;
  setFromLocalPart: (s: string) => void;
  replyTo: string;
  setReplyTo: (s: string) => void;
  sendingDomain: string;
  loading: boolean;
}) {
  const effectiveName = fromName.trim() || 'Ants Dispatch';
  const effectiveLocal = fromLocalPart.trim().toLowerCase() || 'dispatch';
  const previewFrom = sendingDomain
    ? `${effectiveName} <${effectiveLocal}@${sendingDomain}>`
    : `${effectiveName} <${effectiveLocal}@…>`;
  const previewReply = replyTo.trim().toLowerCase() || 'Defaults to From';

  return (
    <div className="card">
      <div className="card-header">
        <div>
          <div className="eyebrow">Workspace</div>
          <h3 className="serif mt-sm">Sender identity</h3>
          <p className="muted" style={{ marginTop: 4, fontSize: 13 }}>
            Controls the <code>From:</code> and <code>Reply-To:</code> headers on
            every outbound newsletter. Individual newsletter types can override
            any of these on the type's detail page.
          </p>
        </div>
      </div>
      <div className="card-body stack" style={{ gap: 16 }}>
        {loading && <p className="muted">Loading…</p>}

        <div className="stack" style={{ gap: 6 }}>
          <label className="eyebrow">From display name</label>
          <input
            type="text"
            value={fromName}
            onChange={(e) => setFromName(e.target.value)}
            placeholder="e.g. Scienthouse Newsletter"
            maxLength={120}
            className="input"
          />
          <p className="muted" style={{ fontSize: 12 }}>
            Shown as the sender label in the recipient's inbox. Defaults to
            "Ants Dispatch" if blank.
          </p>
        </div>

        <div className="stack" style={{ gap: 6 }}>
          <label className="eyebrow">From address</label>
          <div className="row items-center" style={{ gap: 6 }}>
            <input
              type="text"
              value={fromLocalPart}
              onChange={(e) =>
                setFromLocalPart(e.target.value.toLowerCase().replace(/[^a-z0-9._-]/g, ''))
              }
              placeholder="news"
              maxLength={64}
              className="input mono-sm"
              style={{ flex: '0 1 220px', fontFamily: 'var(--mono, monospace)' }}
            />
            <span className="muted mono-sm" style={{ fontSize: 13 }}>
              @{sendingDomain || '<sendingDomain>'}
            </span>
          </div>
          <p className="muted" style={{ fontSize: 12 }}>
            The domain is fixed by SES verification. Local-part: lowercase
            letters, digits, dots, dashes, or underscores. Defaults to{' '}
            <code>dispatch</code> if blank.
          </p>
        </div>

        <div className="stack" style={{ gap: 6 }}>
          <label className="eyebrow">Reply-To (optional)</label>
          <input
            type="email"
            value={replyTo}
            onChange={(e) => setReplyTo(e.target.value)}
            placeholder="hello@brand.com"
            maxLength={254}
            className="input"
          />
          <p className="muted" style={{ fontSize: 12 }}>
            Where replies are routed when the recipient hits Reply. Can be on
            any domain — no SES verification required. Leave blank to have
            replies go to the From address.
          </p>
        </div>

        <div
          style={{
            padding: '10px 12px',
            background: 'var(--paper-deep)',
            borderRadius: 6,
            border: '1px solid var(--rule-soft, #e5e7eb)',
          }}
        >
          <div className="eyebrow" style={{ marginBottom: 4 }}>Preview headers</div>
          <div className="mono-sm" style={{ fontSize: 12.5, lineHeight: 1.6 }}>
            From: {previewFrom}<br />
            Reply-To: <span className={replyTo.trim() ? '' : 'faint'}>{previewReply}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function SubscribeLinksCard() {
  const { data } = useQuery({ queryKey: ['types'], queryFn: () => listTypes() });
  // Only types explicitly opted in for public sign-ups should be linkable;
  // sharing a URL for an invite-only type would surface a 404 to the visitor.
  const types = (data ?? []).filter((t) => !t.archived && t.publicSubscribable);
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const baseUrl = `${origin}/subscribe`;

  return (
    <div className="card">
      <div className="card-header">
        <div>
          <div className="eyebrow">Workspace</div>
          <h3 className="serif mt-sm">Public subscribe links</h3>
          <p className="muted" style={{ marginTop: 4, fontSize: 13 }}>
            Share these URLs anywhere — landing pages, social bios, email
            sigs. Each visitor enters their email, clicks the confirmation
            link we send them, and lands on the active subscriber list.
            Bots are filtered with a honeypot field, a per-IP rate limit,
            and the double opt-in confirmation step. Set
            <code> VITE_TURNSTILE_SITE_KEY</code> + <code>TURNSTILE_SECRET</code>{' '}
            to add an invisible Cloudflare Turnstile challenge.
          </p>
        </div>
      </div>
      <div className="card-body stack" style={{ gap: 14 }}>
        <UrlRow
          label={
            types.length > 1
              ? 'Generic — chooser shown'
              : types.length === 1
                ? `Generic — auto-selects "${types[0].name}"`
                : 'Generic'
          }
          url={baseUrl}
        />
        {types.length > 1 && (
          <div className="stack" style={{ gap: 6 }}>
            <label className="eyebrow">Per newsletter type</label>
            <div className="stack" style={{ gap: 8 }}>
              {types.map((t) => (
                <UrlRow
                  key={t.id}
                  label={t.name}
                  url={`${baseUrl}?type=${encodeURIComponent(t.id)}`}
                />
              ))}
            </div>
          </div>
        )}
        {types.length === 0 && (
          <p className="muted" style={{ fontSize: 12 }}>
            No newsletter types are marked <strong>Allow public sign-ups</strong> yet.
            The page above will show a "subscriptions are currently closed" notice
            until at least one type is opted in.
          </p>
        )}
      </div>
    </div>
  );
}

function UrlRow({ label, url }: { label: string; url: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API blocked — fall back to selecting the input below.
    }
  };
  return (
    <div className="stack" style={{ gap: 4 }}>
      <label className="eyebrow">{label}</label>
      <div className="row items-center gap-sm">
        <input
          type="text"
          value={url}
          readOnly
          onFocus={(e) => e.currentTarget.select()}
          className="input mono-sm"
          style={{ flex: 1, fontSize: 12 }}
        />
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={onCopy}
          title="Copy to clipboard"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="btn btn-sm btn-ghost"
          title="Open in a new tab"
        >
          Open
        </a>
      </div>
    </div>
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
  const html = buildPreviewSrcDoc(
    `<!doctype html><html><body style="margin:0;background:#f9fafb;">${sample}${footer}</body></html>`,
  );
  return (
    <div className="stack" style={{ gap: 6 }}>
      <label className="eyebrow">Preview</label>
      <iframe
        title="Footer preview"
        srcDoc={html}
        sandbox=""
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
