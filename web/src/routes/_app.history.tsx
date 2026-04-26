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
import { OpenBar } from '../components/metrics/OpenBar';
import { StatusPill } from '../components/metrics/StatusPill';
import { TypePill } from '../components/types/TypePill';
import { formatNumber, formatPct } from '../lib/format';

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
            (rate(a.stats?.opened, a.stats?.delivered) -
              rate(b.stats?.opened, b.stats?.delivered)) *
            dir
          );
        case 'ctr':
          return (
            (rate(a.stats?.clicked, a.stats?.delivered) -
              rate(b.stats?.clicked, b.stats?.delivered)) *
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
        acc.opened += c.stats?.opened ?? 0;
        acc.clicked += c.stats?.clicked ?? 0;
        acc.unsubscribed += c.stats?.unsubscribed ?? 0;
        acc.bounced += c.stats?.bounced ?? 0;
        return acc;
      },
      { delivered: 0, opened: 0, clicked: 0, unsubscribed: 0, bounced: 0 },
    );
    // Sparklines plot per-campaign rates oldest-first (the listing is sent-desc).
    const openSpark = sent
      .slice()
      .reverse()
      .map((c) => rate(c.stats?.opened, c.stats?.delivered) * 100);
    const clickSpark = sent
      .slice()
      .reverse()
      .map((c) => rate(c.stats?.clicked, c.stats?.delivered) * 100);
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
          value={formatPct(aggregates.totals.opened, aggregates.totals.delivered)}
          spark={<Sparkline values={aggregates.openSpark} />}
        />
        <Metric
          label="Avg. click-through"
          value={formatPct(aggregates.totals.clicked, aggregates.totals.delivered)}
          spark={<Sparkline values={aggregates.clickSpark} />}
        />
        <Metric
          label="Unsubscribe rate"
          value={formatPct(aggregates.totals.unsubscribed, aggregates.totals.delivered)}
        />
        <Metric
          label="Bounce rate"
          value={formatPct(aggregates.totals.bounced, aggregates.totals.delivered)}
        />
      </div>

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
              {formatPct(c.stats?.opened ?? 0, c.stats?.delivered ?? 0)}
            </span>
            <OpenBar rate={rate(c.stats?.opened, c.stats?.delivered)} />
          </div>
        ) : (
          <span className="faint">—</span>
        )}
      </td>
      <td className="text-right mono-sm">
        {isSent ? (
          formatPct(c.stats?.clicked ?? 0, c.stats?.delivered ?? 0)
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
