import { createFileRoute, Link } from '@tanstack/react-router';
import { useState } from 'react';

export const Route = createFileRoute('/_app/help')({
  component: HelpPage,
});

interface Section {
  id: string;
  title: string;
  blurb: string;
  body: () => React.ReactNode;
}

const SECTIONS: Section[] = [
  {
    id: 'overview',
    title: 'Overview',
    blurb: 'How the pieces fit together',
    body: () => (
      <>
        <p>
          Dispatch is a newsletter tool that turns a HTML draft into an email sent to a tagged
          slice of your contact list. The five core areas live in the left nav:
        </p>
        <ol>
          <li><strong>Types</strong> — categories like “Quarterly” or “Product update” that group newsletters and seed defaults.</li>
          <li><strong>Compose</strong> — write the newsletter body, subject, and tags.</li>
          <li><strong>Subscribers</strong> — manage the contact list and the suppression list.</li>
          <li><strong>Send</strong> — pick recipients, optionally schedule, and dispatch.</li>
          <li><strong>History</strong> — past sends and engagement metrics.</li>
        </ol>
        <p>
          Plus <strong>Settings</strong> (footer + sender info, applied to every send) and this
          Help page.
        </p>
        <p className="muted" style={{ fontSize: 13 }}>
          A typical first run: create a Type → Compose a draft → import or add Subscribers →
          Send → check History.
        </p>
      </>
    ),
  },
  {
    id: 'types',
    title: 'Newsletter types',
    blurb: 'Categories that seed defaults for new newsletters',
    body: () => (
      <>
        <p>
          A <strong>type</strong> is a category — e.g. “Donor update,” “Weekly digest.” Every
          newsletter belongs to one type. Types let you:
        </p>
        <ul>
          <li>Filter History and aggregate stats by type.</li>
          <li>Auto-fill subject prefix, audience tags, and the starting HTML body for new newsletters.</li>
          <li>Color-code the UI so editors immediately recognize what they’re looking at.</li>
        </ul>
        <h4>Editing a type</h4>
        <ol>
          <li>Open <Link to="/types">Types</Link>, click <em>Edit</em> on a row (or <em>+ New type</em>).</li>
          <li>Set name, color (hue slider), description.</li>
          <li><strong>Default subject prefix</strong> — e.g. <code>[Quarterly] </code> auto-fills the subject when composing.</li>
          <li><strong>Default audience tags</strong> — auto-selected on the Send wizard for this type.</li>
          <li><strong>Newsletter template</strong> — the HTML body that pre-fills new newsletters of this type. Edit it visually or in raw HTML.</li>
        </ol>
        <p className="muted" style={{ fontSize: 13 }}>
          Archived types can no longer be selected on new newsletters but stay attached to past
          sends so historical reports keep their grouping.
        </p>
      </>
    ),
  },
  {
    id: 'compose',
    title: 'Compose',
    blurb: 'Authoring newsletters',
    body: () => (
      <>
        <p>
          Click <Link to="/compose">Compose</Link> → <em>+ New newsletter</em>. Pick a type — the
          new draft inherits that type’s subject prefix and template HTML. Drafts autosave every
          ~750ms.
        </p>
        <h4>Editor modes</h4>
        <ul>
          <li><strong>Visual</strong> — WYSIWYG editing (TipTap). Recommended for most users.</li>
          <li><strong>HTML</strong> — raw editing. Use this when pasting hand-coded layouts (tables, complex inline styles).</li>
        </ul>
        <p>
          Switching from HTML → Visual may simplify hand-coded markup; the system warns you the
          first time and snapshots the original so you can hit <em>Restore HTML</em> if needed.
        </p>
        <h4>Images</h4>
        <p>
          Click <em>+ Image</em> to upload a new image or pick a previously uploaded one. Hosted
          on a CDN URL the embedded <code>&lt;img&gt;</code> tag references.
        </p>
        <h4>Test send and continue</h4>
        <p>
          The footer of the editor exposes <em>Send to yourself</em> (preview deliverability with
          the real footer + tracking) and <em>Continue to Send</em> (jumps to the Send wizard
          with this template preselected).
        </p>
        <p className="muted" style={{ fontSize: 13 }}>
          You don’t need to add an unsubscribe link or footer manually — those are appended
          automatically based on <Link to="/settings">Settings</Link>.
        </p>
      </>
    ),
  },
  {
    id: 'subscribers',
    title: 'Subscribers & suppressions',
    blurb: 'Managing the audience',
    body: () => (
      <>
        <p>
          <Link to="/subscribers">Subscribers</Link> shows everyone on your list, with status
          (<em>active</em>, <em>unsubscribed</em>, or <em>bounced</em>) and tags.
        </p>
        <h4>Adding contacts</h4>
        <ul>
          <li><strong>One at a time</strong> — click <em>+ Add subscriber</em>, fill email/name/org/tags.</li>
          <li><strong>Bulk import</strong> — CSV upload via the imports flow. Required column: <code>email</code>. Optional: <code>name</code>, <code>org</code>, <code>tags</code> (semicolon-separated).</li>
        </ul>
        <h4>Tags</h4>
        <p>
          Click a tag pill to remove it. Use the <em>+</em> popover on a row to add more. Tag
          changes save optimistically. Tags drive recipient selection in the Send wizard.
        </p>
        <h4>Suppressions</h4>
        <p>
          Toggle the view to <em>Suppressions</em> to see every email that can no longer receive
          mail — auto-populated from bounces, complaints, and unsubscribe clicks. Suppressions
          survive contact deletion (so re-importing a deleted contact won’t accidentally email
          them).
        </p>
        <p className="muted" style={{ fontSize: 13 }}>
          Removing someone from suppressions is rare — typically only when a bounce was
          transient or someone explicitly asks to be re-added.
        </p>
      </>
    ),
  },
  {
    id: 'send',
    title: 'Send',
    blurb: 'Recipients, timing, and delivery',
    body: () => (
      <>
        <p>The send wizard has three steps:</p>
        <h4>Step 1 — Recipients</h4>
        <ul>
          <li>Pick include tags (e.g. <code>donors</code>) and optional exclude tags.</li>
          <li><strong>Mode All</strong> — recipients must have <em>every</em> include tag. <strong>Mode Any</strong> — at least one. Most users want Any.</li>
          <li>The audience preview updates live with count, top tags, and a sample of contacts.</li>
        </ul>
        <h4>Step 2 — Timing</h4>
        <ul>
          <li><strong>Send now</strong> — enqueues immediately.</li>
          <li><strong>Schedule</strong> — pick date + time + timezone. EventBridge fires at the scheduled instant; you can cancel up until that point from <Link to="/history">History</Link>.</li>
        </ul>
        <h4>Step 3 — Review & send</h4>
        <p>
          Click <em>Preview</em> in the top banner to see the full rendered email (with footer)
          in a modal. Click <em>Send</em> to dispatch.
        </p>
        <p className="muted" style={{ fontSize: 13 }}>
          The audience preview only counts active subscribers — suppressed and unsubscribed
          contacts are filtered out automatically.
        </p>
      </>
    ),
  },
  {
    id: 'history',
    title: 'History & engagement',
    blurb: 'What was sent and how it performed',
    body: () => (
      <>
        <p>
          <Link to="/history">History</Link> lists every campaign with status, recipient count,
          open rate, and click-through rate. Aggregate metric cards at the top sum across the
          current filter (All / Sent / Scheduled / Drafts, optionally narrowed by type).
        </p>
        <h4>Campaign detail</h4>
        <p>Click any row to drill in. The detail page shows:</p>
        <ul>
          <li><strong>Four metric cards</strong> — recipients, opens, clicks, bounces.</li>
          <li><strong>Engagement over time</strong> — opens binned hourly (72h / 7d / All) with peak-hour and 50%-cumulative stats.</li>
          <li><strong>Delivery funnel</strong> — sent → delivered → opened → clicked.</li>
          <li><strong>Top links clicked</strong> — URLs grouped by recipient count and share.</li>
        </ul>
        <h4>Header buttons</h4>
        <ul>
          <li><strong>View content</strong> — opens the original HTML in an iframe modal.</li>
          <li><strong>Duplicate</strong> — preselects this campaign’s template in the Send wizard.</li>
          <li><strong>Export report</strong> — downloads a per-recipient CSV with timestamps.</li>
        </ul>
      </>
    ),
  },
  {
    id: 'settings',
    title: 'Settings (footer & sender)',
    blurb: 'Applied to every email',
    body: () => (
      <>
        <p>
          <Link to="/settings">Settings</Link> stores one footer used on every send. The
          unsubscribe link and your mailing address are added automatically — you cannot omit
          them, and you don’t need to include them in the footer body.
        </p>
        <h4>Required fields</h4>
        <ul>
          <li><strong>Sender mailing address</strong> — required for CAN-SPAM compliance. Saving fails without it.</li>
        </ul>
        <h4>Optional fields</h4>
        <ul>
          <li><strong>Sender name</strong> — bolded line above the address.</li>
          <li><strong>Footer body</strong> — brand text, social links, etc. Edited in the same WYSIWYG editor as Compose.</li>
        </ul>
        <p>Click <em>Preview email</em> to see exactly how the footer renders.</p>
      </>
    ),
  },
  {
    id: 'compliance',
    title: 'Compliance & deliverability',
    blurb: 'Why some safeguards are mandatory',
    body: () => (
      <>
        <h4>Unsubscribe</h4>
        <p>
          Every email carries the visible unsubscribe link plus an <code>List-Unsubscribe</code>
          header so Gmail/Apple Mail show their native one-click button. Suppressions are
          permanent unless you explicitly remove them from <Link to="/subscribers">Subscribers
          → Suppressions</Link>.
        </p>
        <h4>Bounces & complaints</h4>
        <p>
          Hard bounces and spam complaints auto-add the recipient to the suppression list. They
          will be skipped in any future send, even if re-imported.
        </p>
        <h4>Sandbox vs. production</h4>
        <p>
          A new SES account starts in <em>sandbox mode</em>, which only allows sending to
          verified addresses. Production access is requested through the AWS console and
          unrelated to this app’s code.
        </p>
      </>
    ),
  },
  {
    id: 'troubleshooting',
    title: 'Troubleshooting',
    blurb: 'Common issues',
    body: () => (
      <>
        <h4>“My new feature isn’t showing”</h4>
        <p>Hard refresh — the SPA bundle is fingerprinted and CloudFront caches it. ⌘⇧R / Ctrl-Shift-R.</p>
        <h4>“History shows no opens”</h4>
        <p>
          Open events take 1–2 minutes to flow through SES → SNS → events worker. Refresh after
          a couple of minutes. If still empty, you may have sent to a single recipient who hasn’t
          actually opened yet.
        </p>
        <h4>“Send was queued but not delivered”</h4>
        <p>
          Check the <em>Queued</em> tab in History. If the recipient appears with state{' '}
          <em>rejected</em>, they’re probably on the suppression list. State <em>failed</em> usually
          means an SES sandbox limit or a malformed sender domain — check CloudWatch logs for
          <code>worker-send</code>.
        </p>
        <h4>“My footer isn’t appearing”</h4>
        <p>
          Save once on <Link to="/settings">Settings</Link>. If you only filled in mailing
          address (not the WYSIWYG body), that’s expected — the address + unsubscribe row is the
          mandatory baseline; the WYSIWYG body is brand text on top.
        </p>
      </>
    ),
  },
];

function HelpPage() {
  const [active, setActive] = useState<string>('overview');

  return (
    <div className="row" style={{ alignItems: 'flex-start', gap: 24, maxWidth: 1100 }}>
      <aside
        style={{
          position: 'sticky',
          top: 16,
          flex: '0 0 220px',
          alignSelf: 'flex-start',
        }}
      >
        <div className="card">
          <div className="card-header">
            <div>
              <div className="eyebrow">Help</div>
              <h3 className="serif mt-sm">Contents</h3>
            </div>
          </div>
          <div className="card-body" style={{ padding: 8 }}>
            <nav className="stack" style={{ gap: 2 }}>
              {SECTIONS.map((s) => (
                <a
                  key={s.id}
                  href={`#${s.id}`}
                  onClick={() => setActive(s.id)}
                  className="help-toc-item"
                  style={{
                    display: 'block',
                    padding: '8px 10px',
                    fontSize: 13,
                    color: active === s.id ? 'var(--ink)' : 'var(--ink-soft)',
                    background: active === s.id ? 'var(--paper-deep)' : 'transparent',
                    borderRadius: 4,
                    textDecoration: 'none',
                    fontWeight: active === s.id ? 500 : 400,
                  }}
                >
                  {s.title}
                  <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
                    {s.blurb}
                  </div>
                </a>
              ))}
            </nav>
          </div>
        </div>
      </aside>

      <div className="stack" style={{ gap: 20, flex: 1, minWidth: 0 }}>
        <div className="card">
          <div className="card-body" style={{ padding: 20 }}>
            <div className="eyebrow">Help</div>
            <h2 className="serif" style={{ fontSize: 22, marginTop: 6 }}>
              Using Dispatch
            </h2>
            <p className="muted" style={{ fontSize: 14, marginTop: 6 }}>
              A walkthrough of every page and what it does. Skim the section list on the left
              or scroll through top to bottom — each section is self-contained.
            </p>
          </div>
        </div>

        {SECTIONS.map((s) => (
          <section
            key={s.id}
            id={s.id}
            className="card help-section"
            style={{ scrollMarginTop: 96 }}
          >
            <div className="card-header">
              <div>
                <div className="eyebrow">{s.blurb}</div>
                <h3 className="serif mt-sm">{s.title}</h3>
              </div>
            </div>
            <div className="card-body help-body">{s.body()}</div>
          </section>
        ))}
      </div>
    </div>
  );
}
