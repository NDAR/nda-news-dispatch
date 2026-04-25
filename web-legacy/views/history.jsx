// History view — list of past/scheduled/draft newsletters with drill-down

const HistoryView = ({ newsletters, density }) => {
  const [filter, setFilter] = React.useState('all'); // all, sent, scheduled, draft
  const [sortBy, setSortBy] = React.useState('sentAt');
  const [sortDir, setSortDir] = React.useState('desc');
  const [query, setQuery] = React.useState('');
  const [selected, setSelected] = React.useState(null);

  const filtered = newsletters.filter(n => {
    if (filter !== 'all' && n.status !== filter) return false;
    if (query && !n.subject.toLowerCase().includes(query.toLowerCase())) return false;
    return true;
  });

  const sorted = [...filtered].sort((a, b) => {
    const dir = sortDir === 'asc' ? 1 : -1;
    if (sortBy === 'sentAt') {
      const aT = a.sentAt || '0000';
      const bT = b.sentAt || '0000';
      return aT.localeCompare(bT) * dir;
    }
    if (sortBy === 'openRate') {
      return (a.opened / (a.delivered || 1) - b.opened / (b.delivered || 1)) * dir;
    }
    if (sortBy === 'recipients') return (a.recipients - b.recipients) * dir;
    return 0;
  });

  const toggleSort = (col) => {
    if (sortBy === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortBy(col); setSortDir('desc'); }
  };

  // Aggregate metrics (sent only)
  const sent = newsletters.filter(n => n.status === 'sent');
  const totalDelivered = sent.reduce((s, n) => s + n.delivered, 0);
  const totalOpened = sent.reduce((s, n) => s + n.opened, 0);
  const totalClicked = sent.reduce((s, n) => s + n.clicked, 0);
  const totalUnsub = sent.reduce((s, n) => s + n.unsubscribed, 0);
  const totalBounced = sent.reduce((s, n) => s + n.bounced, 0);

  const openSparkData = sent.slice().reverse().map(n => n.opened / (n.delivered || 1) * 100);
  const clickSparkData = sent.slice().reverse().map(n => n.clicked / (n.delivered || 1) * 100);

  if (selected) {
    return <NewsletterDetail newsletter={selected} onBack={() => setSelected(null)} />;
  }

  return (
    <div className="stack" style={{ gap: 20 }}>
      {/* Aggregate metrics */}
      <div className="grid grid-4">
        <Metric label="Avg. open rate" value={pct(totalOpened, totalDelivered)} delta="+2.4 pts vs prior" deltaDir="up" spark={openSparkData} />
        <Metric label="Avg. click-through" value={pct(totalClicked, totalDelivered)} delta="+0.8 pts vs prior" deltaDir="up" spark={clickSparkData} />
        <Metric label="Unsubscribe rate" value={pct(totalUnsub, totalDelivered)} delta="stable" />
        <Metric label="Bounce rate" value={pct(totalBounced, totalDelivered)} delta="well below threshold" />
      </div>

      {/* Controls */}
      <div className="card">
        <div className="card-header">
          <div className="row items-center gap-md">
            <div className="segmented">
              <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>All</button>
              <button className={filter === 'sent' ? 'active' : ''} onClick={() => setFilter('sent')}>Sent</button>
              <button className={filter === 'scheduled' ? 'active' : ''} onClick={() => setFilter('scheduled')}>Scheduled</button>
              <button className={filter === 'draft' ? 'active' : ''} onClick={() => setFilter('draft')}>Drafts</button>
            </div>
            <div className="row items-center gap-sm" style={{
              border: '1px solid var(--rule)', borderRadius: 6, padding: '6px 10px',
              background: 'var(--paper)', minWidth: 240,
            }}>
              <Icon name="search" size={14} />
              <input
                type="text"
                placeholder="Search subject line…"
                value={query}
                onChange={e => setQuery(e.target.value)}
                style={{ border: 'none', outline: 'none', background: 'transparent', flex: 1, fontSize: 13, fontFamily: 'var(--sans)' }}
              />
            </div>
          </div>
          <div className="muted" style={{ fontSize: 12 }}>
            {sorted.length} newsletter{sorted.length === 1 ? '' : 's'}
          </div>
        </div>

        <table className="table">
          <thead>
            <tr>
              <th style={{ width: '36%' }}>Subject</th>
              <th style={{ cursor: 'pointer' }} onClick={() => toggleSort('sentAt')}>
                Sent {sortBy === 'sentAt' && (sortDir === 'asc' ? '↑' : '↓')}
              </th>
              <th style={{ cursor: 'pointer' }} onClick={() => toggleSort('recipients')} className="text-right">
                Recipients
              </th>
              <th style={{ cursor: 'pointer' }} onClick={() => toggleSort('openRate')} className="text-right">
                Open rate {sortBy === 'openRate' && (sortDir === 'asc' ? '↑' : '↓')}
              </th>
              <th className="text-right">CTR</th>
              <th className="text-right">Unsub.</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map(n => (
              <tr key={n.id} className="clickable" onClick={() => n.status === 'sent' && setSelected(n)}>
                <td>
                  <div className="serif" style={{ fontSize: 14.5 }}>{n.subject}</div>
                  <div className="muted mono-sm mt-sm" style={{ fontSize: 11 }}>#{n.id.toUpperCase()}</div>
                </td>
                <td>
                  <div>{fmtDate(n.sentAt)}</div>
                  {n.sentAt && <div className="muted" style={{ fontSize: 11 }}>{fmtRel(n.sentAt)}</div>}
                </td>
                <td className="text-right mono-sm">{n.recipients ? fmt(n.recipients) : '—'}</td>
                <td className="text-right">
                  {n.status === 'sent' ? (
                    <div className="stack" style={{ alignItems: 'flex-end' }}>
                      <span className="mono-sm">{pct(n.opened, n.delivered)}</span>
                      <OpenBar rate={n.opened / n.delivered} />
                    </div>
                  ) : '—'}
                </td>
                <td className="text-right mono-sm">
                  {n.status === 'sent' ? pct(n.clicked, n.delivered) : '—'}
                </td>
                <td className="text-right mono-sm muted">
                  {n.status === 'sent' ? fmt(n.unsubscribed) : '—'}
                </td>
                <td><StatusPill status={n.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

const OpenBar = ({ rate }) => {
  const w = Math.max(4, Math.min(100, rate * 100));
  return (
    <div style={{ width: 60, height: 3, background: 'var(--rule-soft)', borderRadius: 2, marginTop: 3 }}>
      <div style={{ width: `${w}%`, height: '100%', background: 'var(--accent)', borderRadius: 2 }} />
    </div>
  );
};

// Drill-down detail
const NewsletterDetail = ({ newsletter: n, onBack }) => {
  const series = React.useMemo(() => generateOpenSeries(n.opened), [n.opened]);

  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="row items-center gap-md">
        <button className="btn btn-sm btn-ghost" onClick={onBack}>
          <Icon name="arrowleft" size={12} /> Back to history
        </button>
        <span className="muted mono-sm">#{n.id.toUpperCase()}</span>
      </div>

      <div className="row items-start justify-between gap-lg">
        <div style={{ flex: 1 }}>
          <div className="eyebrow">Newsletter</div>
          <h1 className="serif mt-sm">{n.subject}</h1>
          <div className="muted mt-sm" style={{ fontSize: 14 }}>
            Sent {fmtDateTime(n.sentAt)} to {fmt(n.recipients)} subscribers
          </div>
        </div>
        <div className="row gap-sm">
          <button className="btn btn-sm"><Icon name="eye" size={12} /> View content</button>
          <button className="btn btn-sm"><Icon name="refresh" size={12} /> Duplicate</button>
          <button className="btn btn-sm"><Icon name="download" size={12} /> Export report</button>
        </div>
      </div>

      <div className="grid grid-4">
        <Metric label="Delivered" value={fmt(n.delivered)} delta={pct(n.delivered, n.recipients) + ' of sends'} />
        <Metric label="Opens" value={fmt(n.opened)} delta={pct(n.opened, n.delivered) + ' open rate'} deltaDir="up" />
        <Metric label="Clicks" value={fmt(n.clicked)} delta={pct(n.clicked, n.delivered) + ' CTR'} deltaDir="up" />
        <Metric label="Unsubscribes" value={fmt(n.unsubscribed)} delta={pct(n.unsubscribed, n.delivered)} />
      </div>

      <div className="card">
        <div className="card-header">
          <div>
            <div className="eyebrow">Engagement over time</div>
            <h3 className="serif mt-sm">Opens in the 72 hours after send</h3>
          </div>
          <div className="segmented">
            <button className="active">72h</button>
            <button>7d</button>
            <button>All</button>
          </div>
        </div>
        <div className="card-body">
          <LineChart data={series} height={240} />
          <div className="row gap-lg mt-md" style={{ paddingTop: 12, borderTop: '1px solid var(--rule-soft)' }}>
            <div>
              <div className="label">Peak hour</div>
              <div className="serif" style={{ fontSize: 18 }}>1h after send</div>
              <div className="muted" style={{ fontSize: 12 }}>312 opens that hour</div>
            </div>
            <div>
              <div className="label">50% of opens by</div>
              <div className="serif" style={{ fontSize: 18 }}>6 hours</div>
              <div className="muted" style={{ fontSize: 12 }}>faster than average</div>
            </div>
            <div>
              <div className="label">Most common client</div>
              <div className="serif" style={{ fontSize: 18 }}>Gmail (58%)</div>
              <div className="muted" style={{ fontSize: 12 }}>then Outlook, Apple Mail</div>
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-2">
        <div className="card">
          <div className="card-header">
            <h3 className="serif">Delivery funnel</h3>
          </div>
          <div className="card-body">
            <Funnel steps={[
              { label: 'Sent', value: n.recipients, base: n.recipients },
              { label: 'Delivered', value: n.delivered, base: n.recipients },
              { label: 'Opened', value: n.opened, base: n.recipients },
              { label: 'Clicked', value: n.clicked, base: n.recipients },
            ]} />
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <h3 className="serif">Top links clicked</h3>
          </div>
          <div className="card-body" style={{ padding: 0 }}>
            <table className="table">
              <thead>
                <tr><th>URL</th><th className="text-right">Clicks</th><th className="text-right">%</th></tr>
              </thead>
              <tbody>
                {[
                  { url: '/release/4.1-notes', clicks: 412 },
                  { url: '/guid-policy-2026', clicks: 178 },
                  { url: '/office-hours', clicks: 89 },
                  { url: '/deadlines/may-1', clicks: 45 },
                ].map((l, i) => (
                  <tr key={i}>
                    <td className="mono-sm" style={{ color: 'var(--accent-deep)' }}>{l.url}</td>
                    <td className="text-right mono-sm">{fmt(l.clicks)}</td>
                    <td className="text-right mono-sm muted">{((l.clicks / n.clicked) * 100).toFixed(0)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
};

const Funnel = ({ steps }) => {
  const max = steps[0].base;
  return (
    <div className="stack" style={{ gap: 10 }}>
      {steps.map((s, i) => {
        const pctW = (s.value / max) * 100;
        return (
          <div key={i}>
            <div className="row justify-between items-center" style={{ fontSize: 13, marginBottom: 4 }}>
              <span className="serif">{s.label}</span>
              <span><span className="mono-sm">{fmt(s.value)}</span> <span className="muted mono-sm">({pctW.toFixed(1)}%)</span></span>
            </div>
            <div style={{ height: 8, background: 'var(--paper-deep)', borderRadius: 4, overflow: 'hidden' }}>
              <div style={{
                width: `${pctW}%`, height: '100%',
                background: `oklch(from var(--accent) calc(l + ${i * 0.04}) c h)`,
                borderRadius: 4, transition: 'width 0.4s',
              }} />
            </div>
          </div>
        );
      })}
    </div>
  );
};

Object.assign(window, { HistoryView, NewsletterDetail });
