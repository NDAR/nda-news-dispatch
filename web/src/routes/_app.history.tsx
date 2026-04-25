import { createFileRoute } from '@tanstack/react-router';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  cancelScheduledCampaign,
  listCampaigns,
  previewAudience,
  type Campaign,
  type CampaignStatus,
} from '../api/endpoints';

export const Route = createFileRoute('/_app/history')({
  component: HistoryPage,
});

const STATUSES: CampaignStatus[] = ['scheduled', 'sent', 'queued', 'draft', 'failed'];

function HistoryPage() {
  const qc = useQueryClient();
  const [status, setStatus] = useState<CampaignStatus>('scheduled');
  const { data, isLoading, error } = useQuery({
    queryKey: ['campaigns', status],
    queryFn: () => listCampaigns(status),
    // Scheduled rows are time-sensitive (the table shows when each will fire);
    // refetch every 30s so the user doesn't have to reload to see a row
    // disappear once the dispatch worker picks it up.
    refetchInterval: status === 'scheduled' ? 30_000 : false,
  });

  const cancelMut = useMutation({
    mutationFn: (id: string) => cancelScheduledCampaign(id),
    onSuccess: () => {
      // Both 'scheduled' (row removed) and 'draft' (row added back) need
      // to refresh.
      qc.invalidateQueries({ queryKey: ['campaigns'] });
    },
  });

  // Scheduled campaigns don't have `recipients` materialized yet — that
  // happens when the dispatch worker actually fires. Fetch a live audience
  // preview per row so the user sees the count that *would* be sent given
  // current subscriber state.
  const scheduledItems: Campaign[] = status === 'scheduled' ? (data?.items ?? []) : [];
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

  return (
    <div className="card">
      <div className="card-header">
        <div>
          <div className="eyebrow">Archive</div>
          <h3 className="serif mt-sm">History</h3>
        </div>
        <div className="segmented">
          {STATUSES.map((s) => (
            <button key={s} className={status === s ? 'active' : ''} onClick={() => setStatus(s)}>
              {s[0].toUpperCase() + s.slice(1)}
            </button>
          ))}
        </div>
      </div>
      <div className="card-body" style={{ padding: 0 }}>
        {isLoading && <p className="muted" style={{ padding: 16 }}>Loading…</p>}
        {error && (
          <p style={{ color: 'var(--bad)', padding: 16 }}>
            Failed to load campaigns: {(error as Error).message}
          </p>
        )}
        {data && (
          <table className="table">
            <thead>
              <tr>
                <th>Name / Subject</th>
                {status === 'scheduled' ? (
                  <>
                    <th>Audience</th>
                    <th className="text-right">Recipients</th>
                    <th>Scheduled for</th>
                    <th />
                  </>
                ) : (
                  <>
                    <th className="text-right">Recipients</th>
                    <th className="text-right">Delivered</th>
                    <th className="text-right">Opens</th>
                    <th className="text-right">Clicks</th>
                    <th>Sent</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {data.items.length === 0 && (
                <tr>
                  <td colSpan={status === 'scheduled' ? 5 : 6} className="text-center muted" style={{ padding: 24 }}>
                    No {status} campaigns.
                  </td>
                </tr>
              )}
              {data.items.map((c) => (
                <tr key={c.id}>
                  <td>
                    <div className="serif" style={{ fontSize: 14 }}>{c.name}</div>
                    <div className="muted" style={{ fontSize: 11.5, marginTop: 2 }}>{c.subject}</div>
                  </td>
                  {status === 'scheduled' ? (
                    <>
                      <td><AudienceCell campaign={c} /></td>
                      <td className="text-right mono-sm">
                        {(() => {
                          const p = previewByCampaign.get(c.id);
                          if (!p) return <span className="faint">—</span>;
                          if (p.loading) return <span className="muted">…</span>;
                          return p.count.toLocaleString();
                        })()}
                      </td>
                      <td className="mono-sm">
                        {c.scheduleAt ? (
                          <ScheduledFor iso={c.scheduleAt} />
                        ) : (
                          <span className="faint">—</span>
                        )}
                      </td>
                      <td className="text-right">
                        <button
                          className="btn btn-sm"
                          style={{ color: 'var(--bad)' }}
                          disabled={cancelMut.isPending}
                          onClick={() => {
                            if (
                              confirm(
                                `Cancel scheduled send of "${c.name}"?\n\nThe campaign will revert to a draft.`,
                              )
                            ) {
                              cancelMut.mutate(c.id);
                            }
                          }}
                        >
                          {cancelMut.isPending && cancelMut.variables === c.id ? 'Cancelling…' : 'Cancel'}
                        </button>
                      </td>
                    </>
                  ) : (
                    <>
                      <td className="text-right mono-sm">
                        {c.recipients > 0 ? c.recipients : <span className="faint">—</span>}
                      </td>
                      <td className="text-right mono-sm">{c.stats?.delivered ?? 0}</td>
                      <td className="text-right mono-sm">{c.stats?.opened ?? 0}</td>
                      <td className="text-right mono-sm">{c.stats?.clicked ?? 0}</td>
                      <td className="muted mono-sm">
                        {c.sentAt ? new Date(c.sentAt).toLocaleString() : '—'}
                      </td>
                    </>
                  )}
                </tr>
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
  );
}

function AudienceCell({ campaign }: { campaign: Campaign }) {
  const { tags, excludeTags, tagMode } = campaign;
  if (tags.length === 0 && excludeTags.length === 0) {
    return <span className="muted" style={{ fontSize: 12 }}>All active subscribers</span>;
  }
  return (
    <div className="stack" style={{ gap: 4 }}>
      {tags.length > 0 && (
        <div className="row items-center" style={{ gap: 4, flexWrap: 'wrap' }}>
          <span className="muted" style={{ fontSize: 11 }}>
            {tagMode === 'all' ? 'all of' : 'any of'}
          </span>
          {tags.map((t) => (
            <span key={t} className="pill" style={{ fontSize: 11 }}>{t}</span>
          ))}
        </div>
      )}
      {excludeTags.length > 0 && (
        <div className="row items-center" style={{ gap: 4, flexWrap: 'wrap' }}>
          <span className="muted" style={{ fontSize: 11 }}>excluding</span>
          {excludeTags.map((t) => (
            <span
              key={t}
              className="pill"
              style={{ fontSize: 11, background: 'oklch(0.95 0.02 25)', color: 'var(--bad)' }}
            >
              {t}
            </span>
          ))}
        </div>
      )}
    </div>
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
        timeZoneName: 'short',
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
