import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import {
  getCampaign,
  getType,
  listCampaignLinks,
  listCampaignRecipients,
  type Campaign,
  type CampaignLink,
  type CampaignRecipient,
} from '../api/endpoints';
import { Metric } from '../components/metrics/Metric';
import { LineChart } from '../components/metrics/LineChart';
import { StatusPill } from '../components/metrics/StatusPill';
import { TypePill } from '../components/types/TypePill';
import { formatNumber, formatPct, formatDateTime } from '../lib/format';
import { buildPreviewSrcDoc } from '../lib/previewFrame';

export const Route = createFileRoute('/_app/history/$campaignId')({
  component: CampaignDetailPage,
});

type RangeKey = '72h' | '7d' | 'all';

function CampaignDetailPage() {
  const { campaignId } = Route.useParams();
  const navigate = useNavigate();
  const [range, setRange] = useState<RangeKey>('72h');
  const [contentOpen, setContentOpen] = useState(false);

  const { data, isLoading, error } = useQuery<Campaign & { stats?: Record<string, number> }>({
    queryKey: ['campaign', campaignId],
    queryFn: () => getCampaign(campaignId),
  });

  const typeQ = useQuery({
    queryKey: ['type', data?.typeId],
    queryFn: () => getType(data!.typeId!),
    enabled: !!data?.typeId,
  });

  const recipientsQ = useQuery({
    queryKey: ['campaign-recipients', campaignId],
    queryFn: () => listCampaignRecipients(campaignId),
  });

  if (isLoading) {
    return <p className="muted" style={{ padding: 16 }}>Loading…</p>;
  }
  if (error || !data) {
    return (
      <div className="card">
        <div className="card-body">
          <p style={{ color: 'var(--bad)' }}>
            Failed to load campaign: {(error as Error | undefined)?.message ?? 'Not found'}
          </p>
          <Link to="/history" className="btn btn-sm" style={{ marginTop: 12 }}>
            ← Back to history
          </Link>
        </div>
      </div>
    );
  }

  const stats = data.stats ?? {};
  const recipients = data.recipients ?? 0;
  const delivered = stats.delivered ?? 0;
  const opened = stats.opened ?? 0;
  const clicked = stats.clicked ?? 0;
  // Headline rates use unique-recipient counters when available. Older
  // campaigns sent before unique tracking shipped fall back to total events,
  // which can show a rate above 100% from multi-opens / image-proxy reloads.
  const uniqueOpened = stats.uniqueOpened ?? opened;
  const uniqueClicked = stats.uniqueClicked ?? clicked;
  const unsubscribed = stats.unsubscribed ?? 0;
  const bounced = stats.bounced ?? 0;

  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="row items-center gap-md">
        <button className="btn btn-sm" onClick={() => navigate({ to: '/history' })}>
          ← Back to history
        </button>
        <span className="muted mono-sm">#{data.id.slice(0, 8).toUpperCase()}</span>
        <StatusPill status={data.status} />
      </div>

      <div className="row items-center justify-between gap-lg">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="row items-center gap-sm">
            <div className="eyebrow">Newsletter</div>
            {data.typeId && <TypePill type={typeQ.data} />}
          </div>
          <h1 className="serif mt-sm" style={{ fontSize: 28 }}>
            {data.subject || data.name}
          </h1>
          <div className="muted mt-sm" style={{ fontSize: 14 }}>
            {data.sentAt ? `Sent ${formatDateTime(data.sentAt)}` : 'Not yet sent'}{' '}
            {recipients > 0 && (
              <>
                to <strong style={{ color: 'var(--ink-soft)' }}>{formatNumber(recipients)}</strong>{' '}
                subscriber{recipients === 1 ? '' : 's'}
              </>
            )}
          </div>
          <AudienceTagsRow
            tags={data.tags}
            excludeTags={data.excludeTags}
            tagMode={data.tagMode}
          />
        </div>
        <div className="row gap-sm" style={{ flexShrink: 0 }}>
          <button className="btn btn-sm" onClick={() => setContentOpen(true)}>
            View content
          </button>
          <button
            className="btn btn-sm"
            disabled={!data.templateId}
            title={data.templateId ? 'Send a new campaign from the same template' : 'Original template missing'}
            onClick={() => {
              if (!data.templateId) return;
              window.localStorage.setItem('dispatch.send.preselectTemplate', data.templateId);
              navigate({ to: '/send' });
            }}
          >
            Duplicate
          </button>
          <button
            className="btn btn-sm"
            disabled={!recipientsQ.data?.items?.length}
            title="Download per-recipient engagement as CSV"
            onClick={() => exportCsv(data, recipientsQ.data?.items ?? [])}
          >
            Export report
          </button>
        </div>
      </div>

      <div className="grid grid-4">
        <Metric
          label="Delivered"
          value={formatNumber(delivered)}
          delta={`${formatPct(delivered, recipients)} of sends`}
        />
        <Metric
          label="Opens"
          value={formatNumber(uniqueOpened)}
          delta={
            <>
              {formatPct(uniqueOpened, delivered)} open rate
              {opened > uniqueOpened && (
                <span className="muted" style={{ marginLeft: 6 }}>
                  · {formatNumber(opened)} total
                </span>
              )}
            </>
          }
          deltaDir="up"
        />
        <Metric
          label="Clicks"
          value={formatNumber(uniqueClicked)}
          delta={
            <>
              {formatPct(uniqueClicked, delivered)} CTR
              {clicked > uniqueClicked && (
                <span className="muted" style={{ marginLeft: 6 }}>
                  · {formatNumber(clicked)} total
                </span>
              )}
            </>
          }
          deltaDir="up"
        />
        <Metric
          label="Unsubscribes"
          value={formatNumber(unsubscribed)}
          delta={formatPct(unsubscribed, delivered)}
        />
      </div>

      <EngagementOverTime
        sentAt={data.sentAt}
        recipients={recipients}
        delivered={delivered}
        rcpts={recipientsQ.data?.items ?? []}
        loading={recipientsQ.isLoading}
        truncated={recipientsQ.data?.truncated ?? false}
        range={range}
        onRangeChange={setRange}
      />

      <TopLinks campaignId={data.id} fallbackRcpts={recipientsQ.data?.items ?? []} totalClicks={clicked} />
      {bounced > 0 && (
        <div className="muted" style={{ fontSize: 12 }}>
          {formatNumber(bounced)} bounced ({formatPct(bounced, recipients)})
        </div>
      )}

      {contentOpen && (
        <ContentModal html={data.html} subject={data.subject} onClose={() => setContentOpen(false)} />
      )}
    </div>
  );
}

// ── Engagement-over-time card ─────────────────────────────────────────────

function EngagementOverTime({
  sentAt,
  recipients,
  delivered,
  rcpts,
  loading,
  truncated,
  range,
  onRangeChange,
}: {
  sentAt: string | undefined;
  recipients: number;
  delivered: number;
  rcpts: CampaignRecipient[];
  loading: boolean;
  truncated: boolean;
  range: RangeKey;
  onRangeChange: (r: RangeKey) => void;
}) {
  // Build the per-bucket cumulative-opens series. The bucket window varies by
  // range: 72h = 73 hourly buckets, 7d = 169 hourly buckets, all = day-bucketed
  // up to "now". `h` is the bucket index in its native unit so x-axis labels
  // can append "h" or "d" in LineChart.
  const series = useMemo(() => {
    if (!sentAt) return [] as { h: number; cumulative: number }[];
    const sentMs = Date.parse(sentAt);
    if (Number.isNaN(sentMs)) return [];
    const opens = rcpts
      .map((r) => (r.openedAt ? Date.parse(r.openedAt) - sentMs : null))
      .filter((d): d is number => d !== null && d >= 0);
    opens.sort((a, b) => a - b);

    let bucketCount: number;
    let bucketMs: number;
    if (range === '72h') {
      bucketCount = 73;
      bucketMs = 60 * 60 * 1000;
    } else if (range === '7d') {
      bucketCount = 169;
      bucketMs = 60 * 60 * 1000;
    } else {
      const elapsed = Date.now() - sentMs;
      const days = Math.max(1, Math.ceil(elapsed / (24 * 60 * 60 * 1000)));
      bucketCount = days + 1;
      bucketMs = 24 * 60 * 60 * 1000;
    }
    const points: { h: number; cumulative: number }[] = [];
    let cum = 0;
    let oi = 0;
    for (let i = 0; i < bucketCount; i++) {
      const upper = (i + 1) * bucketMs;
      while (oi < opens.length && opens[oi] < upper) {
        cum += 1;
        oi += 1;
      }
      points.push({ h: i, cumulative: cum });
    }
    return points;
  }, [rcpts, sentAt, range]);

  // Peak hour: argmax of per-bucket DELTAS (not cumulative), reported in hours
  // since send. Always derived from the 72h bucket window — the visual range
  // toggle changes the chart but not the headline stat.
  const peak = useMemo(() => {
    if (!sentAt) return null;
    const sentMs = Date.parse(sentAt);
    const buckets = new Array(73).fill(0);
    for (const r of rcpts) {
      if (!r.openedAt) continue;
      const dh = Math.floor((Date.parse(r.openedAt) - sentMs) / (60 * 60 * 1000));
      if (dh >= 0 && dh < buckets.length) buckets[dh] += 1;
    }
    let maxIdx = 0;
    for (let i = 1; i < buckets.length; i++) {
      if (buckets[i] > buckets[maxIdx]) maxIdx = i;
    }
    return { hour: maxIdx, count: buckets[maxIdx] };
  }, [rcpts, sentAt]);

  // 50%-cumulative: smallest hour where cumulative reaches half of total opens.
  const halfTime = useMemo(() => {
    if (!sentAt) return null;
    const sentMs = Date.parse(sentAt);
    const opens = rcpts
      .map((r) => (r.openedAt ? Date.parse(r.openedAt) - sentMs : null))
      .filter((d): d is number => d !== null && d >= 0)
      .sort((a, b) => a - b);
    if (opens.length === 0) return null;
    const halfMs = opens[Math.floor(opens.length / 2)];
    return Math.max(0, Math.round(halfMs / (60 * 60 * 1000)));
  }, [rcpts, sentAt]);

  const xUnit = range === 'all' ? 'd' : 'h';

  return (
    <div className="card">
      <div className="card-header">
        <div>
          <div className="eyebrow">Engagement over time</div>
          <h3 className="serif mt-sm">
            {range === '72h' && 'Opens in the 72 hours after send'}
            {range === '7d' && 'Opens in the 7 days after send'}
            {range === 'all' && 'Opens since send'}
          </h3>
        </div>
        <div className="segmented">
          <button className={range === '72h' ? 'active' : ''} onClick={() => onRangeChange('72h')}>72h</button>
          <button className={range === '7d' ? 'active' : ''} onClick={() => onRangeChange('7d')}>7d</button>
          <button className={range === 'all' ? 'active' : ''} onClick={() => onRangeChange('all')}>All</button>
        </div>
      </div>
      <div className="card-body">
        {loading ? (
          <div style={{ height: 240, display: 'grid', placeItems: 'center' }}>
            <span className="muted" style={{ fontSize: 12 }}>Loading recipient data…</span>
          </div>
        ) : (
          <LineChart data={series} height={240} xUnit={xUnit} />
        )}
        {truncated && (
          <div className="muted" style={{ fontSize: 11, marginTop: 6, fontStyle: 'italic' }}>
            Showing the first 5,000 recipients — chart and stats may understate larger campaigns.
          </div>
        )}
        <div
          className="row gap-lg"
          style={{ marginTop: 28, paddingTop: 16, borderTop: '1px solid var(--rule-soft)' }}
        >
          <div>
            <div className="label">Peak hour</div>
            <div className="serif" style={{ fontSize: 18 }}>
              {peak ? `${peak.hour}h after send` : '—'}
            </div>
            <div className="muted" style={{ fontSize: 12 }}>
              {peak ? `${formatNumber(peak.count)} open${peak.count === 1 ? '' : 's'} that hour` : 'no opens yet'}
            </div>
          </div>
          <div>
            <div className="label">50% of opens by</div>
            <div className="serif" style={{ fontSize: 18 }}>
              {halfTime !== null ? `${halfTime} hour${halfTime === 1 ? '' : 's'}` : '—'}
            </div>
            <div className="muted" style={{ fontSize: 12 }}>
              {halfTime !== null ? 'after send' : 'waiting for opens'}
            </div>
          </div>
          <div>
            <div className="label">Total reached</div>
            <div className="serif" style={{ fontSize: 18 }}>
              {formatNumber(delivered)}
            </div>
            <div className="muted" style={{ fontSize: 12 }}>
              of {formatNumber(recipients)} sent
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Top links clicked ─────────────────────────────────────────────────────

function TopLinks({
  campaignId,
  fallbackRcpts,
  totalClicks,
}: {
  campaignId: string;
  fallbackRcpts: CampaignRecipient[];
  totalClicks: number;
}) {
  const linksQ = useQuery({
    queryKey: ['campaign', campaignId, 'links'],
    queryFn: () => listCampaignLinks(campaignId),
  });

  // Endpoint-backed rows are authoritative — they have both total clicks and
  // unique-recipient clicks per URL. Campaigns sent before LINK#-row tracking
  // shipped will return an empty list; in that case we fall back to the old
  // recipient-row aggregation (which only reflects `lastClickUrl` per
  // recipient) and display total only.
  const apiRows: (CampaignLink & { _legacy?: false })[] = linksQ.data?.items ?? [];
  const useLegacy = !linksQ.isLoading && apiRows.length === 0;

  const legacyRows = useMemo(() => {
    if (!useLegacy) return [];
    const counts = new Map<string, number>();
    for (const r of fallbackRcpts) {
      if (!r.lastClickUrl) continue;
      counts.set(r.lastClickUrl, (counts.get(r.lastClickUrl) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([url, count]) => ({ url, clicks: count, uniqueClicks: count }));
  }, [fallbackRcpts, useLegacy]);

  const rows = useLegacy ? legacyRows : apiRows.slice(0, 10);
  const denom = totalClicks || rows.reduce((s, r) => s + r.clicks, 0);

  return (
    <div className="card">
      <div className="card-header">
        <h3 className="serif">Top links clicked</h3>
        {useLegacy && rows.length > 0 && (
          <span className="muted" style={{ fontSize: 12, marginLeft: 8 }}>
            (legacy aggregation — last-clicked link per recipient)
          </span>
        )}
      </div>
      <div className="card-body" style={{ padding: 0 }}>
        {linksQ.isLoading ? (
          <p className="muted" style={{ padding: 24, textAlign: 'center' }}>Loading…</p>
        ) : rows.length === 0 ? (
          <p className="muted" style={{ padding: 24, textAlign: 'center' }}>
            No clicks recorded yet.
          </p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>URL</th>
                <th className="text-right">Clicks</th>
                <th className="text-right">Unique</th>
                <th className="text-right">% of total</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((l) => (
                <tr key={l.url}>
                  <td
                    className="mono-sm"
                    style={{
                      color: 'var(--accent-deep)',
                      wordBreak: 'break-all',
                    }}
                  >
                    <a
                      href={l.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ color: 'inherit', textDecoration: 'none' }}
                    >
                      {l.url}
                    </a>
                  </td>
                  <td className="text-right mono-sm" style={{ whiteSpace: 'nowrap' }}>
                    {formatNumber(l.clicks)}
                  </td>
                  <td className="text-right mono-sm" style={{ whiteSpace: 'nowrap' }}>
                    {useLegacy ? '—' : formatNumber(l.uniqueClicks)}
                  </td>
                  <td className="text-right mono-sm muted" style={{ whiteSpace: 'nowrap' }}>
                    {denom ? `${Math.round((l.clicks / denom) * 100)}%` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ── View-content modal ─────────────────────────────────────────────────────

function ContentModal({
  html,
  subject,
  onClose,
}: {
  html: string;
  subject: string;
  onClose: () => void;
}) {
  // Esc to close — modal CSS already handles backdrop click.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-lg" onClick={(e) => e.stopPropagation()} style={{ width: '90vw', maxWidth: 900, height: '85vh', display: 'flex', flexDirection: 'column' }}>
        <div className="modal-header">
          <div className="eyebrow">Newsletter content</div>
          <h2 className="serif" style={{ fontSize: 18, marginTop: 4 }}>
            {subject || '(no subject)'}
          </h2>
        </div>
        <div className="modal-body" style={{ flex: 1, padding: '8px 16px 16px' }}>
          <iframe
            title="campaign-content"
            srcDoc={buildPreviewSrcDoc(html)}
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

// ── CSV export ─────────────────────────────────────────────────────────────

function exportCsv(campaign: Campaign, rcpts: CampaignRecipient[]) {
  const headers = [
    'email',
    'state',
    'queuedAt',
    'deliveredAt',
    'openedAt',
    'clickedAt',
    'lastClickUrl',
    'bouncedAt',
    'bounceType',
    'complainedAt',
  ];
  const rows = rcpts.map((r) =>
    headers
      .map((h) => csvEscape(String((r as unknown as Record<string, unknown>)[h] ?? '')))
      .join(','),
  );
  const csv = [headers.join(','), ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  a.href = url;
  a.download = `campaign-${campaign.id.slice(0, 8)}-${stamp}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function csvEscape(v: string): string {
  if (/[",\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

/**
 * Renders the include/exclude tag selection that targeted this campaign.
 * Skips entirely when neither include nor exclude tags are set so it doesn't
 * leave a dangling label on legacy or "everyone" sends.
 */
function AudienceTagsRow({
  tags,
  excludeTags,
  tagMode,
}: {
  tags: string[];
  excludeTags: string[];
  tagMode: 'all' | 'any';
}) {
  const hasInc = tags.length > 0;
  const hasExc = excludeTags.length > 0;
  if (!hasInc && !hasExc) return null;
  return (
    <div className="muted mt-sm" style={{ fontSize: 13, lineHeight: 1.6 }}>
      <span className="eyebrow" style={{ marginRight: 8 }}>Audience</span>
      {hasInc && (
        <>
          <span style={{ marginRight: 6 }}>
            {tagMode === 'all' ? 'matches all of' : 'matches any of'}
          </span>
          <TagChips tags={tags} />
        </>
      )}
      {hasExc && (
        <>
          {hasInc && <span style={{ margin: '0 8px' }}>·</span>}
          <span style={{ marginRight: 6 }}>excluding</span>
          <TagChips tags={excludeTags} variant="exclude" />
        </>
      )}
    </div>
  );
}

function TagChips({
  tags,
  variant = 'include',
}: {
  tags: string[];
  variant?: 'include' | 'exclude';
}) {
  return (
    <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 4, verticalAlign: 'middle' }}>
      {tags.map((t) => (
        <span
          key={t}
          className="mono-sm"
          style={{
            fontSize: 11,
            padding: '1px 7px',
            borderRadius: 999,
            border: '1px solid var(--rule-soft, #e5e5e5)',
            background: variant === 'exclude' ? 'oklch(96% 0.03 30)' : 'var(--paper-deep, #f4efe5)',
            color: variant === 'exclude' ? 'oklch(35% 0.12 30)' : 'var(--ink-soft, #2a2420)',
          }}
        >
          #{t}
        </span>
      ))}
    </span>
  );
}
