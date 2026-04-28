import { createFileRoute, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import {
  cancelScheduledCampaign,
  listCampaigns,
  listTypes,
  previewAudience,
  type Campaign,
  type CampaignStatus,
  type NewsletterType,
} from '../api/endpoints';
import { Metric } from '../components/metrics/Metric';
import { Sparkline } from '../components/metrics/Sparkline';
import { LineChart } from '../components/metrics/LineChart';
import { OpenBar } from '../components/metrics/OpenBar';
import { StatusPill } from '../components/metrics/StatusPill';
import { TypePill } from '../components/types/TypePill';
import { formatDate, formatNumber, formatPct } from '../lib/format';
import { useEffect } from 'react';

export const Route = createFileRoute('/_app/history')({
  component: HistoryPage,
});

// Tabs match the legacy design: All combines every status, Sent/Scheduled/Drafts
// scope to one. The underlying CampaignStatus 'queued' is the storage state for
// successfully-sent campaigns (there is no separate 'sent' status); we label it
// "Sent" so users see their mental model, not the schema.
type TabKey = 'all' | 'queued' | 'scheduled' | 'draft';
const TABS: TabKey[] = ['all', 'queued', 'scheduled', 'draft'];
const TAB_LABEL: Record<TabKey, string> = {
  all: 'All',
  queued: 'Sent',
  scheduled: 'Scheduled',
  draft: 'Drafts',
};
// Statuses we fan out to populate the "All" tab. 'failed' is included so failed
// campaigns aren't silently hidden, even though the legacy design only had four
// visible tabs.
const ALL_STATUSES: CampaignStatus[] = ['queued', 'scheduled', 'draft', 'failed'];

type SortKey = 'sentAt' | 'recipients' | 'openRate' | 'ctr';
type SortDir = 'asc' | 'desc';

function HistoryPage() {
  // The detail route `_app.history.$campaignId.tsx` nests under this route in
  // the file-routes tree, which means this component still mounts when the
  // user navigates to /history/<id>. We render <Outlet /> for child paths so
  // the detail page actually shows; otherwise we render the list.
  const { location } = useRouterState();
  if (location.pathname !== '/history' && location.pathname !== '/history/') {
    return <Outlet />;
  }
  return <HistoryList />;
}

function HistoryList() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [tab, setTab] = useState<TabKey>('all');
  const [query, setQuery] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('sentAt');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  // 'all' = no filter; specific id = restrict to that type. Includes archived
  // types so historical campaigns under an archived type still surface here.
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [trendMetric, setTrendMetric] = useState<MetricKey | null>(null);

  const { data: types = [] } = useQuery({
    queryKey: ['types', true],
    queryFn: () => listTypes(true),
  });
  const typeById = useMemo(() => new Map(types.map((t) => [t.id, t])), [types]);

  // Fan out one query per status so the "All" tab has data and the metrics row
  // (which is always derived from queued/sent campaigns) can render no matter
  // which tab is selected. React Query dedupes by queryKey across re-renders.
  const statusQueries = useQueries({
    queries: ALL_STATUSES.map((s) => ({
      queryKey: ['campaigns', s],
      queryFn: () => listCampaigns(s),
      // Refetch the scheduled list periodically so rows disappear when the
      // dispatch worker fires; everything else is stable enough to skip polling.
      refetchInterval: s === 'scheduled' ? 30_000 : false,
    })),
  });
  const byStatus = new Map<CampaignStatus, Campaign[]>();
  ALL_STATUSES.forEach((s, i) => {
    byStatus.set(s, statusQueries[i]?.data?.items ?? []);
  });
  const isLoading = statusQueries.some((q) => q.isLoading);
  const error = statusQueries.find((q) => q.error)?.error as Error | undefined;

  const cancelMut = useMutation({
    mutationFn: (id: string) => cancelScheduledCampaign(id),
    onSuccess: () => {
      // Both the scheduled and draft lists need to refresh.
      qc.invalidateQueries({ queryKey: ['campaigns'] });
    },
  });

  // Live audience preview for scheduled rows — these don't have `recipients`
  // materialized until the dispatch worker fires, so we substitute the count
  // that *would* be sent given current subscriber state. Fired regardless of
  // which tab is selected because scheduled rows can appear under "All".
  const scheduledItems = byStatus.get('scheduled') ?? [];
  const previewQueries = useQueries({
    queries: scheduledItems.map((c) => ({
      queryKey: ['audience-preview', c.tagMode, c.tags, c.excludeTags] as const,
      queryFn: () =>
        previewAudience({
          tagMode: c.tagMode,
          tags: c.tags,
          excludeTags: c.excludeTags,
        }),
      staleTime: 60_000,
    })),
  });
  const previewByCampaign = new Map<string, { count: number; loading: boolean }>();
  scheduledItems.forEach((c, i) => {
    const q = previewQueries[i];
    previewByCampaign.set(c.id, {
      count: q?.data?.count ?? 0,
      loading: !!q?.isLoading,
    });
  });

  const tabItems = useMemo<Campaign[]>(() => {
    if (tab === 'all') {
      return ALL_STATUSES.flatMap((s) => byStatus.get(s) ?? []);
    }
    return byStatus.get(tab) ?? [];
    // byStatus is rebuilt every render; depending on the underlying query data
    // is what actually changes the result.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, ...statusQueries.map((q) => q.data)]);

  const visibleItems = useMemo(() => {
    const q = query.trim().toLowerCase();
    const byType = typeFilter === 'all'
      ? tabItems
      : tabItems.filter((c) => c.typeId === typeFilter);
    const filtered = q
      ? byType.filter(
          (c) =>
            (c.subject ?? '').toLowerCase().includes(q) ||
            (c.name ?? '').toLowerCase().includes(q),
        )
      : byType;
    const sorted = [...filtered].sort((a, b) => {
      const dir = sortDir === 'asc' ? 1 : -1;
      switch (sortKey) {
        case 'sentAt': {
          // Scheduled rows have no sentAt yet — fall back to scheduleAt so
          // they don't all collapse to the bottom in "All".
          const aT = a.sentAt ?? a.scheduleAt ?? a.createdAt ?? '';
          const bT = b.sentAt ?? b.scheduleAt ?? b.createdAt ?? '';
          return aT.localeCompare(bT) * dir;
        }
        case 'recipients':
          return ((a.recipients ?? 0) - (b.recipients ?? 0)) * dir;
        case 'openRate':
          return (
            (rate(a.stats?.uniqueOpened ?? a.stats?.opened, a.stats?.delivered) -
              rate(b.stats?.uniqueOpened ?? b.stats?.opened, b.stats?.delivered)) *
            dir
          );
        case 'ctr':
          return (
            (rate(a.stats?.uniqueClicked ?? a.stats?.clicked, a.stats?.delivered) -
              rate(b.stats?.uniqueClicked ?? b.stats?.clicked, b.stats?.delivered)) *
            dir
          );
      }
    });
    return sorted;
  }, [tabItems, query, sortKey, sortDir, typeFilter]);

  // Aggregates are always shown at the top — regardless of selected tab — and
  // always derived from the queued (sent) campaigns since the other statuses
  // have no engagement data yet. When a Type filter is active, the aggregates
  // narrow to that type so users can compare engagement across categories.
  const aggregates = useMemo(() => {
    const allSent = byStatus.get('queued') ?? [];
    const sent = typeFilter === 'all'
      ? allSent
      : allSent.filter((c) => c.typeId === typeFilter);
    const totals = sent.reduce(
      (acc, c) => {
        acc.delivered += c.stats?.delivered ?? 0;
        acc.uniqueOpened += c.stats?.uniqueOpened ?? c.stats?.opened ?? 0;
        acc.uniqueClicked += c.stats?.uniqueClicked ?? c.stats?.clicked ?? 0;
        acc.unsubscribed += c.stats?.unsubscribed ?? 0;
        acc.bounced += c.stats?.bounced ?? 0;
        return acc;
      },
      { delivered: 0, uniqueOpened: 0, uniqueClicked: 0, unsubscribed: 0, bounced: 0 },
    );
    // Sparklines plot per-campaign rates oldest-first (the listing is sent-desc).
    const openSpark = sent
      .slice()
      .reverse()
      .map((c) => rate(c.stats?.uniqueOpened ?? c.stats?.opened, c.stats?.delivered) * 100);
    const clickSpark = sent
      .slice()
      .reverse()
      .map((c) => rate(c.stats?.uniqueClicked ?? c.stats?.clicked, c.stats?.delivered) * 100);
    return { totals, openSpark, clickSpark, count: sent.length };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusQueries[0]?.data, typeFilter]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortKey(key);
      setSortDir('desc');
    }
  }

  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="grid grid-4">
        <Metric
          label={`Avg. open rate${typeFilter !== 'all' ? ` · ${typeById.get(typeFilter)?.name ?? ''}` : ''}`}
          value={formatPct(aggregates.totals.uniqueOpened, aggregates.totals.delivered)}
          spark={<Sparkline values={aggregates.openSpark} />}
          onClick={() => setTrendMetric('open')}
        />
        <Metric
          label="Avg. click-through"
          value={formatPct(aggregates.totals.uniqueClicked, aggregates.totals.delivered)}
          spark={<Sparkline values={aggregates.clickSpark} />}
          onClick={() => setTrendMetric('click')}
        />
        <Metric
          label="Unsubscribe rate"
          value={formatPct(aggregates.totals.unsubscribed, aggregates.totals.delivered)}
          onClick={() => setTrendMetric('unsub')}
        />
        <Metric
          label="Bounce rate"
          value={formatPct(aggregates.totals.bounced, aggregates.totals.delivered)}
          onClick={() => setTrendMetric('bounce')}
        />
      </div>
      {trendMetric && (
        <MetricTrendModal
          metric={trendMetric}
          campaigns={byStatus.get('queued') ?? []}
          typeFilter={typeFilter}
          typeById={typeById}
          onClose={() => setTrendMetric(null)}
        />
      )}

      <div className="card">
        <div className="card-header">
          <div className="row items-center gap-md">
            <div className="segmented">
              {TABS.map((t) => (
                <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
                  {TAB_LABEL[t]}
                </button>
              ))}
            </div>
            {types.length > 0 && (
              <select
                className="select"
                value={typeFilter}
                onChange={(e) => setTypeFilter(e.target.value)}
                style={{ fontSize: 12, padding: '6px 8px' }}
                title="Filter by newsletter type"
              >
                <option value="all">All types</option>
                {types.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                    {t.archived ? ' (archived)' : ''}
                  </option>
                ))}
              </select>
            )}
          </div>
          <div className="row items-center gap-md" style={{ flex: '0 1 auto', minWidth: 0 }}>
            <input
              type="text"
              className="input"
              placeholder="Search subject or name…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              style={{ fontSize: 12, padding: '6px 10px', width: 220 }}
            />
            <div className="muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
              {visibleItems.length} newsletter{visibleItems.length === 1 ? '' : 's'}
            </div>
          </div>
        </div>
        <div className="card-body" style={{ padding: 0 }}>
          {isLoading && <p className="muted" style={{ padding: 16 }}>Loading…</p>}
          {error && (
            <p style={{ color: 'var(--bad)', padding: 16 }}>
              Failed to load campaigns: {error.message}
            </p>
          )}
          {!isLoading && !error && (
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: '32%' }}>Subject</th>
                  <SortHeader
                    label="Sent"
                    active={sortKey === 'sentAt'}
                    dir={sortDir}
                    onClick={() => toggleSort('sentAt')}
                  />
                  <SortHeader
                    label="Recipients"
                    align="right"
                    active={sortKey === 'recipients'}
                    dir={sortDir}
                    onClick={() => toggleSort('recipients')}
                  />
                  <SortHeader
                    label="Open rate"
                    align="right"
                    active={sortKey === 'openRate'}
                    dir={sortDir}
                    onClick={() => toggleSort('openRate')}
                  />
                  <SortHeader
                    label="CTR"
                    align="right"
                    active={sortKey === 'ctr'}
                    dir={sortDir}
                    onClick={() => toggleSort('ctr')}
                  />
                  <th className="text-right">Unsub.</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {visibleItems.length === 0 && (
                  <tr>
                    <td
                      colSpan={7}
                      className="text-center muted"
                      style={{ padding: 24 }}
                    >
                      {query
                        ? `No campaigns match "${query}".`
                        : `No ${TAB_LABEL[tab].toLowerCase()} campaigns.`}
                    </td>
                  </tr>
                )}
                {visibleItems.map((c) => (
                  <CampaignRow
                    key={c.id}
                    campaign={c}
                    type={c.typeId ? typeById.get(c.typeId) : undefined}
                    audiencePreview={previewByCampaign.get(c.id)}
                    onClick={() =>
                      navigate({
                        to: '/history/$campaignId',
                        params: { campaignId: c.id },
                      })
                    }
                    onCancel={
                      c.status === 'scheduled'
                        ? () => {
                            if (
                              confirm(
                                `Cancel scheduled send of "${c.name}"?\n\nThe campaign will revert to a draft.`,
                              )
                            ) {
                              cancelMut.mutate(c.id);
                            }
                          }
                        : undefined
                    }
                    cancelling={cancelMut.isPending && cancelMut.variables === c.id}
                  />
                ))}
              </tbody>
            </table>
          )}
          {cancelMut.error && (
            <p style={{ color: 'var(--bad)', padding: '8px 16px', fontSize: 12 }}>
              Cancel failed: {(cancelMut.error as Error).message}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function CampaignRow({
  campaign: c,
  audiencePreview,
  type,
  onClick,
  onCancel,
  cancelling,
}: {
  campaign: Campaign;
  audiencePreview?: { count: number; loading: boolean };
  type: NewsletterType | undefined;
  onClick?: () => void;
  onCancel?: () => void;
  cancelling: boolean;
}) {
  const isSent = c.status === 'queued' || c.status === 'sending' || c.status === 'sent';
  const isScheduled = c.status === 'scheduled';
  // For sent rows show the actual recipient count; for scheduled rows show the
  // live audience preview so the user knows what's about to go out.
  const recipientCell = (() => {
    if (isScheduled) {
      if (audiencePreview?.loading) return <span className="muted">…</span>;
      const n = audiencePreview?.count ?? 0;
      return n > 0 ? formatNumber(n) : <span className="faint">—</span>;
    }
    return c.recipients > 0 ? formatNumber(c.recipients) : <span className="faint">—</span>;
  })();

  return (
    <tr className={onClick ? 'clickable' : undefined} onClick={onClick}>
      <td>
        {type && (
          <div style={{ marginBottom: 4 }}>
            <TypePill type={type} />
          </div>
        )}
        <div className="serif" style={{ fontSize: 14 }}>
          {c.name}
        </div>
        <div className="muted" style={{ fontSize: 11.5, marginTop: 2 }}>
          {c.subject || <em className="faint">(no subject)</em>}
        </div>
        <CompactAudienceTags
          tags={c.tags}
          excludeTags={c.excludeTags}
          tagMode={c.tagMode}
        />
      </td>
      <td className="mono-sm muted">
        {isSent && c.sentAt ? (
          new Date(c.sentAt).toLocaleString(undefined, {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
          })
        ) : isScheduled && c.scheduleAt ? (
          <ScheduledFor iso={c.scheduleAt} />
        ) : (
          <span className="faint">—</span>
        )}
      </td>
      <td className="text-right mono-sm">{recipientCell}</td>
      <td className="text-right">
        {isSent ? (
          <div className="stack" style={{ alignItems: 'flex-end', gap: 0 }}>
            <span className="mono-sm">
              {formatPct(c.stats?.uniqueOpened ?? c.stats?.opened ?? 0, c.stats?.delivered ?? 0)}
            </span>
            <OpenBar rate={rate(c.stats?.uniqueOpened ?? c.stats?.opened, c.stats?.delivered)} />
          </div>
        ) : (
          <span className="faint">—</span>
        )}
      </td>
      <td className="text-right mono-sm">
        {isSent ? (
          formatPct(c.stats?.uniqueClicked ?? c.stats?.clicked ?? 0, c.stats?.delivered ?? 0)
        ) : (
          <span className="faint">—</span>
        )}
      </td>
      <td className="text-right mono-sm muted">
        {isSent ? formatNumber(c.stats?.unsubscribed ?? 0) : <span className="faint">—</span>}
      </td>
      <td>
        <div className="row items-center gap-sm">
          <StatusPill status={c.status} />
          {onCancel && (
            <button
              className="btn btn-sm"
              style={{ color: 'var(--bad)', fontSize: 11, padding: '2px 8px' }}
              disabled={cancelling}
              onClick={(e) => {
                e.stopPropagation();
                onCancel();
              }}
            >
              {cancelling ? '…' : 'Cancel'}
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

function rate(num: number | undefined, den: number | undefined): number {
  if (!den) return 0;
  return (num ?? 0) / den;
}

/**
 * One-line summary of the include/exclude tags used to target a campaign.
 * Compact enough for a table cell — strikethrough on excluded tags so the
 * include/exclude split reads at a glance without a separate label. Hidden
 * entirely when no tags were used (everyone-send).
 */
function CompactAudienceTags({
  tags,
  excludeTags,
  tagMode,
}: {
  tags: string[];
  excludeTags: string[];
  tagMode: 'all' | 'any';
}) {
  if (tags.length === 0 && excludeTags.length === 0) return null;
  return (
    <div
      className="muted"
      style={{ fontSize: 11, marginTop: 4, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4 }}
    >
      {tags.length > 0 && (
        <span
          className="mono-sm faint"
          style={{ fontSize: 10, marginRight: 2 }}
          title={tagMode === 'all' ? 'Recipient must have ALL of these tags' : 'Recipient must have ANY of these tags'}
        >
          {tagMode === 'all' ? 'all of' : 'any of'}
        </span>
      )}
      {tags.map((t) => (
        <span key={t} className="mono-sm" style={chipStyle()}>#{t}</span>
      ))}
      {excludeTags.length > 0 && (
        <span className="mono-sm faint" style={{ fontSize: 10, marginLeft: tags.length > 0 ? 4 : 0, marginRight: 2 }}>
          except
        </span>
      )}
      {excludeTags.map((t) => (
        <span key={t} className="mono-sm" style={chipStyle('exclude')}>#{t}</span>
      ))}
    </div>
  );
}

function chipStyle(variant: 'include' | 'exclude' = 'include'): React.CSSProperties {
  return {
    fontSize: 10.5,
    padding: '1px 6px',
    borderRadius: 999,
    border: '1px solid var(--rule-soft, #e5e5e5)',
    background: variant === 'exclude' ? 'oklch(96% 0.03 30)' : 'var(--paper-deep, #f4efe5)',
    color: variant === 'exclude' ? 'oklch(35% 0.12 30)' : 'var(--ink-soft, #2a2420)',
  };
}

function SortHeader({
  label,
  active,
  dir,
  align,
  onClick,
}: {
  label: string;
  active: boolean;
  dir: SortDir;
  align?: 'right';
  onClick: () => void;
}) {
  return (
    <th
      onClick={onClick}
      style={{ cursor: 'pointer', userSelect: 'none' }}
      className={align === 'right' ? 'text-right' : undefined}
    >
      {label} {active && (dir === 'asc' ? '↑' : '↓')}
    </th>
  );
}

function ScheduledFor({ iso }: { iso: string }) {
  const d = new Date(iso);
  const ms = d.getTime() - Date.now();
  const inFuture = ms > 0;
  const rel = formatRelative(ms);
  return (
    <>
      {d.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })}
      <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
        {inFuture ? `in ${rel}` : `${rel} ago`}
      </div>
    </>
  );
}

function formatRelative(ms: number): string {
  const abs = Math.abs(ms);
  const min = Math.round(abs / 60_000);
  if (min < 60) return `${min} min`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? '' : 's'}`;
  const day = Math.round(hr / 24);
  return `${day} day${day === 1 ? '' : 's'}`;
}

// ── Metric trend modal ─────────────────────────────────────────────────────

type MetricKey = 'open' | 'click' | 'unsub' | 'bounce';

type CampaignStats = NonNullable<Campaign['stats']>;

const METRIC_META: Record<MetricKey, { title: string; numeratorOf: (s: CampaignStats | undefined) => number | undefined }> = {
  open: { title: 'Open rate', numeratorOf: (s) => s?.uniqueOpened ?? s?.opened },
  click: { title: 'Click-through rate', numeratorOf: (s) => s?.uniqueClicked ?? s?.clicked },
  unsub: { title: 'Unsubscribe rate', numeratorOf: (s) => s?.unsubscribed },
  bounce: { title: 'Bounce rate', numeratorOf: (s) => s?.bounced },
};

function MetricTrendModal({
  metric,
  campaigns,
  typeFilter,
  typeById,
  onClose,
}: {
  metric: MetricKey;
  campaigns: Campaign[];
  typeFilter: string;
  typeById: Map<string, NewsletterType>;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const { title, numeratorOf } = METRIC_META[metric];
  const filtered = useMemo(() => {
    const sent = typeFilter === 'all' ? campaigns : campaigns.filter((c) => c.typeId === typeFilter);
    // Oldest → newest. Skip campaigns with no delivered stats since the rate
    // would be undefined.
    return sent
      .filter((c) => (c.stats?.delivered ?? 0) > 0 && !!c.sentAt)
      .sort((a, b) => new Date(a.sentAt!).getTime() - new Date(b.sentAt!).getTime());
  }, [campaigns, typeFilter]);

  const series = useMemo(
    () =>
      filtered.map((c, i) => ({
        h: i + 1,
        cumulative: rate(numeratorOf(c.stats), c.stats?.delivered) * 100,
      })),
    [filtered, numeratorOf],
  );

  const summary = useMemo(() => {
    if (series.length === 0) return null;
    const values = series.map((s) => s.cumulative);
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    const max = Math.max(...values);
    const min = Math.min(...values);
    const peakIdx = values.indexOf(max);
    const lowIdx = values.indexOf(min);
    return { avg, max, min, peak: filtered[peakIdx], low: filtered[lowIdx] };
  }, [series, filtered]);

  const typeLabel = typeFilter !== 'all' ? typeById.get(typeFilter)?.name : null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal modal-lg"
        onClick={(e) => e.stopPropagation()}
        style={{ width: '92vw', maxWidth: 920, display: 'flex', flexDirection: 'column' }}
      >
        <div className="modal-header">
          <div className="eyebrow">Trend over time</div>
          <h2 className="serif" style={{ fontSize: 18, marginTop: 4 }}>
            {title}
            {typeLabel ? <span className="muted" style={{ fontSize: 14 }}> · {typeLabel}</span> : null}
          </h2>
          <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            One point per sent campaign, oldest to newest. Y axis is the rate (%).
          </p>
        </div>
        <div className="modal-body" style={{ padding: '12px 16px 16px' }}>
          {series.length < 2 ? (
            <p className="muted" style={{ padding: 24, textAlign: 'center' }}>
              Not enough sent campaigns yet to draw a trend.
            </p>
          ) : (
            <>
              <div style={{ height: 280, marginBottom: 40 }}>
                <LineChart data={series} height={280} xUnit="" />
              </div>
              <div
                className="row items-start"
                style={{
                  paddingTop: 16,
                  borderTop: '1px solid var(--rule-soft)',
                  justifyContent: 'space-between',
                  gap: 24,
                  flexWrap: 'wrap',
                }}
              >
                <div style={{ flex: '1 1 0', minWidth: 160 }}>
                  <div className="label">Average</div>
                  <div className="serif" style={{ fontSize: 20 }}>
                    {summary!.avg.toFixed(1)}%
                  </div>
                  <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
                    across {series.length} campaign{series.length === 1 ? '' : 's'}
                  </div>
                </div>
                <div style={{ flex: '1 1 0', minWidth: 200 }}>
                  <div className="label">Peak</div>
                  <div className="serif" style={{ fontSize: 20 }}>
                    {summary!.max.toFixed(1)}%
                  </div>
                  <div
                    className="muted"
                    style={{
                      fontSize: 12,
                      marginTop: 2,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    title={summary!.peak?.subject || summary!.peak?.name}
                  >
                    {summary!.peak?.subject || summary!.peak?.name}
                    {summary!.peak?.sentAt ? ` · ${formatDate(summary!.peak.sentAt)}` : ''}
                  </div>
                </div>
                <div style={{ flex: '1 1 0', minWidth: 200 }}>
                  <div className="label">Low</div>
                  <div className="serif" style={{ fontSize: 20 }}>
                    {summary!.min.toFixed(1)}%
                  </div>
                  <div
                    className="muted"
                    style={{
                      fontSize: 12,
                      marginTop: 2,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    title={summary!.low?.subject || summary!.low?.name}
                  >
                    {summary!.low?.subject || summary!.low?.name}
                    {summary!.low?.sentAt ? ` · ${formatDate(summary!.low.sentAt)}` : ''}
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
        <div className="modal-footer" style={{ justifyContent: 'flex-end' }}>
          <button className="btn btn-sm" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
