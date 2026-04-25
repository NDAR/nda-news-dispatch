// Icons — simple line icons, 16px default
const Icon = ({ name, size = 16, stroke = 1.5 }) => {
  const props = {
    width: size, height: size, viewBox: '0 0 24 24',
    fill: 'none', stroke: 'currentColor', strokeWidth: stroke,
    strokeLinecap: 'round', strokeLinejoin: 'round',
    className: 'nav-icon',
  };
  const paths = {
    compose: <><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></>,
    edit: <><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></>,
    users: <><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></>,
    send: <><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></>,
    history: <><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></>,
    plus: <><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></>,
    upload: <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></>,
    download: <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></>,
    search: <><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></>,
    filter: <><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></>,
    calendar: <><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></>,
    clock: <><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></>,
    check: <><polyline points="20 6 9 17 4 12"/></>,
    checkcircle: <><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></>,
    x: <><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></>,
    arrowleft: <><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></>,
    arrowright: <><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></>,
    arrowup: <><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></>,
    arrowdown: <><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></>,
    eye: <><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></>,
    mouse: <><path d="M2 12h6"/><path d="M22 12h-6"/><circle cx="12" cy="12" r="4"/></>,
    trash: <><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></>,
    more: <><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></>,
    refresh: <><polyline points="23 4 23 10 17 10"/><path d="M20.49 15A9 9 0 1 1 5.64 5.64L23 10"/></>,
    code: <><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></>,
    doc: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></>,
    inbox: <><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></>,
    external: <><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></>,
    alert: <><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></>,
    sliders: <><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></>,
  };
  return <svg {...props}>{paths[name] || null}</svg>;
};

// Sparkline component
const Sparkline = ({ data, color = 'var(--accent)', height = 22, width = 80 }) => {
  if (!data || data.length === 0) return null;
  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;
  const points = data.map((v, i) => {
    const x = (i / (data.length - 1)) * width;
    const y = height - ((v - min) / range) * (height - 2) - 1;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return (
    <svg className="spark" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
      <polyline points={points} fill="none" stroke={color} strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
};

// Line chart for drill-down
const LineChart = ({ data, height = 200, xLabel = 'Hours since send', yLabel = 'Cumulative opens', color = 'var(--accent)' }) => {
  const width = 720;
  const padding = { top: 16, right: 16, bottom: 32, left: 48 };
  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;
  const xs = data.map((d, i) => i);
  const ys = data.map(d => d.cumulative);
  const maxY = Math.max(...ys, 1);
  const xScale = (i) => padding.left + (i / (data.length - 1)) * plotW;
  const yScale = (v) => padding.top + plotH - (v / maxY) * plotH;
  const linePath = data.map((d, i) => `${i === 0 ? 'M' : 'L'}${xScale(i).toFixed(1)},${yScale(d.cumulative).toFixed(1)}`).join(' ');
  const areaPath = `${linePath} L${xScale(data.length - 1).toFixed(1)},${padding.top + plotH} L${xScale(0).toFixed(1)},${padding.top + plotH} Z`;

  const yTicks = 4;
  const xTicks = 6;

  return (
    <div className="chart">
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" style={{ width: '100%', height }}>
        <defs>
          <linearGradient id="lc-grad" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.18" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        {/* Y grid */}
        {Array.from({ length: yTicks + 1 }).map((_, i) => {
          const v = (maxY / yTicks) * i;
          const y = yScale(v);
          return (
            <g key={i}>
              <line x1={padding.left} x2={width - padding.right} y1={y} y2={y} stroke="var(--rule-soft)" strokeWidth="1" />
              <text x={padding.left - 8} y={y + 3} textAnchor="end" className="chart-label">
                {v >= 1000 ? (v / 1000).toFixed(1) + 'k' : Math.round(v)}
              </text>
            </g>
          );
        })}
        {/* X labels */}
        {Array.from({ length: xTicks + 1 }).map((_, i) => {
          const idx = Math.round(((data.length - 1) / xTicks) * i);
          const x = xScale(idx);
          return (
            <text key={i} x={x} y={height - padding.bottom + 16} textAnchor="middle" className="chart-label">
              {data[idx].h}h
            </text>
          );
        })}
        <path d={areaPath} fill="url(#lc-grad)" />
        <path d={linePath} fill="none" stroke={color} strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
};

// Avatar
const Avatar = ({ name, size = 28 }) => {
  const initials = name.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();
  return (
    <div className="avatar" style={{ width: size, height: size, fontSize: size * 0.46 }}>
      {initials}
    </div>
  );
};

// Pill status
const StatusPill = ({ status }) => {
  const cls = status === 'sent' ? 'sent' : status === 'scheduled' ? 'scheduled' : 'draft';
  const label = status[0].toUpperCase() + status.slice(1);
  return <span className={`pill ${cls}`}><span className="pill-dot"></span>{label}</span>;
};

// Metric card
const Metric = ({ label, value, unit, delta, deltaDir, spark }) => (
  <div className="metric">
    <div className="metric-label">{label}</div>
    <div className="metric-value">
      {value}{unit && <span className="unit">{unit}</span>}
    </div>
    <div className="row items-center justify-between" style={{ marginTop: 2 }}>
      {delta && (
        <div className={`metric-delta ${deltaDir || ''}`}>
          {deltaDir === 'up' && <Icon name="arrowup" size={12} />}
          {deltaDir === 'down' && <Icon name="arrowdown" size={12} />}
          {delta}
        </div>
      )}
      {spark && <Sparkline data={spark} />}
    </div>
  </div>
);

// Number formatting
const fmt = (n) => n.toLocaleString('en-US');
const pct = (num, den) => den > 0 ? ((num / den) * 100).toFixed(1) + '%' : '—';
const fmtDate = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};
const fmtDateTime = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) +
    ' · ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
};
const fmtRel = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  const ms = Date.now() - d.getTime();
  const days = Math.floor(ms / 86400000);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
};

Object.assign(window, {
  Icon, Sparkline, LineChart, Avatar, StatusPill, Metric,
  fmt, pct, fmtDate, fmtDateTime, fmtRel,
});
