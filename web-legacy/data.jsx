// Sample data for NDA Newsletter — NIMH Data Archive theme

// Tag palette — curated set with warm hues
const TAG_CATALOG = [
  { id: 'researcher', label: 'Researcher', hue: 45 },
  { id: 'pi', label: 'Principal Investigator', hue: 25 },
  { id: 'contributor', label: 'Data Contributor', hue: 145 },
  { id: 'clinician', label: 'Clinician', hue: 220 },
  { id: 'international', label: 'International', hue: 280 },
  { id: 'new', label: 'New (< 90d)', hue: 180 },
  { id: 'power-user', label: 'Power User', hue: 340 },
  { id: 'press', label: 'Press & Media', hue: 320 },
];

const DEFAULT_HTML = `<!doctype html>
<html>
<head>
  <style>
    body { font-family: 'Source Serif 4', Georgia, serif; color: #2a2420; max-width: 600px; margin: 0 auto; padding: 32px 24px; background: #faf7f1; }
    h1 { font-size: 28px; margin: 0 0 4px; letter-spacing: -0.02em; }
    .eyebrow { font-family: -apple-system, Inter, sans-serif; font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase; color: #8a7f70; margin-bottom: 18px; }
    .lede { font-size: 16px; line-height: 1.55; color: #554a40; font-style: italic; border-left: 2px solid #b8895a; padding-left: 14px; margin: 20px 0 28px; }
    h2 { font-size: 18px; margin: 28px 0 8px; border-bottom: 1px solid #e6decf; padding-bottom: 6px; }
    p { line-height: 1.65; font-size: 15px; }
    .item { margin: 14px 0; }
    .item-title { font-weight: 600; font-family: -apple-system, Inter, sans-serif; font-size: 14px; }
    .item-meta { color: #8a7f70; font-size: 12px; font-family: -apple-system, Inter, sans-serif; margin-top: 2px; }
    a { color: #b8895a; }
    .footer { margin-top: 40px; padding-top: 20px; border-top: 1px solid #e6decf; font-family: -apple-system, Inter, sans-serif; font-size: 12px; color: #8a7f70; }
  </style>
</head>
<body>
  <div class="eyebrow">NDA Dispatch · Issue No. 47</div>
  <h1>April data release &amp; new submission window</h1>

  <div class="lede">
    Spring release 4.1 is now available, containing 12,847 new subject records across 38 studies — plus a revised GUID policy taking effect May 15.
  </div>

  <h2>What's new this month</h2>

  <div class="item">
    <div class="item-title">Release 4.1 — Spring Collection</div>
    <div class="item-meta">Available Apr 20 · 12,847 subjects · 38 studies</div>
    <p>Includes new longitudinal imaging data from the ABCD consortium and two completed RDoC studies. <a href="#">View the release notes →</a></p>
  </div>

  <div class="item">
    <div class="item-title">GUID Policy Revision</div>
    <div class="item-meta">Effective May 15</div>
    <p>We are retiring the legacy GUID tool in favor of the new pseudo-GUID workflow. Existing identifiers remain valid; no migration required.</p>
  </div>

  <h2>Upcoming deadlines</h2>
  <p><strong>May 1</strong> &mdash; Semi-annual data submission deadline for active contracts.<br/>
  <strong>Jun 30</strong> &mdash; Proposal window for the Summer Data Challenge opens.</p>

  <h2>Office hours</h2>
  <p>Drop in Tuesdays 2–3pm ET for submission help, validation questions, or access inquiries. No appointment needed.</p>

  <div class="footer">
    You're receiving this because you're a registered NDA user. <a href="#">Unsubscribe</a> · <a href="#">Update preferences</a><br/>
    National Institute of Mental Health · Bethesda, MD
  </div>
</body>
</html>`;

const SAMPLE_SUBSCRIBERS = [];

// Past newsletters
const PAST_NEWSLETTERS = [
  {
    id: 'n47', subject: "April data release & new submission window", sentAt: '2026-04-15T09:00',
    recipients: 2847, delivered: 2801, opened: 1963, clicked: 724, unsubscribed: 7, bounced: 46,
    status: 'sent',
  },
  {
    id: 'n46', subject: "March: ABCD Release 3.9 + policy update", sentAt: '2026-03-15T09:00',
    recipients: 2812, delivered: 2768, opened: 1847, clicked: 612, unsubscribed: 11, bounced: 44,
    status: 'sent',
  },
  {
    id: 'n45', subject: "Announcing the Summer Data Challenge", sentAt: '2026-02-28T09:00',
    recipients: 2790, delivered: 2745, opened: 2104, clicked: 891, unsubscribed: 4, bounced: 45,
    status: 'sent',
  },
  {
    id: 'n44', subject: "February dispatch: RDoC updates, new validator", sentAt: '2026-02-14T09:00',
    recipients: 2778, delivered: 2736, opened: 1598, clicked: 432, unsubscribed: 9, bounced: 42,
    status: 'sent',
  },
  {
    id: 'n43', subject: "January release 3.8 & office hours resume", sentAt: '2026-01-20T10:00',
    recipients: 2751, delivered: 2710, opened: 1712, clicked: 503, unsubscribed: 6, bounced: 41,
    status: 'sent',
  },
  {
    id: 'n42', subject: "Year in review — 2025 NDA data at a glance", sentAt: '2025-12-20T09:00',
    recipients: 2721, delivered: 2682, opened: 2201, clicked: 1038, unsubscribed: 3, bounced: 39,
    status: 'sent',
  },
  {
    id: 'n41', subject: "December: Holiday data-use agreement reminder", sentAt: '2025-12-01T09:00',
    recipients: 2698, delivered: 2659, opened: 1402, clicked: 287, unsubscribed: 15, bounced: 39,
    status: 'sent',
  },
  {
    id: 'n40', subject: "November release 3.7 & GUID tool v2", sentAt: '2025-11-15T09:00',
    recipients: 2654, delivered: 2619, opened: 1789, clicked: 614, unsubscribed: 8, bounced: 35,
    status: 'sent',
  },
  {
    id: 'n48d', subject: "May dispatch — draft", sentAt: null,
    recipients: 0, delivered: 0, opened: 0, clicked: 0, unsubscribed: 0, bounced: 0,
    status: 'draft',
  },
  {
    id: 'n48s', subject: "Maintenance window — Apr 29 overnight", sentAt: '2026-04-29T20:00',
    recipients: 2847, delivered: 0, opened: 0, clicked: 0, unsubscribed: 0, bounced: 0,
    status: 'scheduled',
  },
];

// Time-series opens for drill-down (hours since send, 0-72)
function generateOpenSeries(total) {
  const points = [];
  // Exponential decay with initial burst
  for (let h = 0; h <= 72; h++) {
    const spike = Math.exp(-h / 8) * 0.25;
    const ramp = Math.max(0, 1 - h / 72) * 0.04;
    points.push({ h, cumulative: Math.round(total * (1 - Math.exp(-h / 6)) * (0.82 + 0.18 * Math.random() * 0)), rate: spike + ramp });
  }
  return points;
}

// Multiple newsletters (drafts)
const SAMPLE_DRAFTS = [
  {
    id: 'd1',
    title: 'Monthly Dispatch — May',
    subject: 'April data release & new submission window',
    html: DEFAULT_HTML,
    updatedAt: '2026-04-24T11:30',
    targetTags: [],
  },
  {
    id: 'd2',
    title: 'PI-only — Policy update',
    subject: 'Action needed: GUID policy revision takes effect May 15',
    html: DEFAULT_HTML.replace('April data release &amp; new submission window', 'Action needed: GUID policy revision takes effect May 15'),
    updatedAt: '2026-04-22T14:12',
    targetTags: ['pi'],
  },
  {
    id: 'd3',
    title: 'Welcome — New subscribers',
    subject: 'Welcome to the NDA Dispatch',
    html: DEFAULT_HTML.replace('April data release &amp; new submission window', 'Welcome to the NDA Dispatch'),
    updatedAt: '2026-04-15T09:00',
    targetTags: ['new'],
  },
  {
    id: 'd4',
    title: 'International partners briefing',
    subject: 'Data-sharing agreements: Q2 update for international partners',
    html: DEFAULT_HTML.replace('April data release &amp; new submission window', 'Q2 update for international partners'),
    updatedAt: '2026-04-10T08:40',
    targetTags: ['international'],
  },
];

Object.assign(window, {
  DEFAULT_HTML,
  TAG_CATALOG,
  SAMPLE_SUBSCRIBERS,
  SAMPLE_DRAFTS,
  PAST_NEWSLETTERS,
  generateOpenSeries,
});
