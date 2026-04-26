interface LineChartProps {
  /** Each point's `h` is its x-position (e.g. hours-since-send), `cumulative`
   *  the y value. Caller controls bucket granularity. */
  data: { h: number; cumulative: number }[];
  height?: number;
  /** Suffix appended to x-axis tick labels — e.g. "h" for hours, "d" for days. */
  xUnit?: string;
  color?: string;
}

/**
 * Pure-SVG line + area chart. No chart library. Ported from the legacy
 * `web-legacy/ui.jsx` design so the new History detail page matches the
 * original look. Renders into a 720-wide viewBox with `preserveAspectRatio
 * none` so the SVG stretches to whatever width its container has.
 */
export function LineChart({ data, height = 240, xUnit = 'h', color = 'var(--accent)' }: LineChartProps) {
  const width = 720;
  const padding = { top: 16, right: 16, bottom: 32, left: 48 };
  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;

  if (data.length < 2) {
    return (
      <div className="chart" style={{ height, display: 'grid', placeItems: 'center' }}>
        <span className="muted" style={{ fontSize: 12 }}>
          Not enough data to plot yet.
        </span>
      </div>
    );
  }

  const ys = data.map((d) => d.cumulative);
  const yTicks = 4;
  // Ensure integer-valued ticks so small datasets don't show "0, 0, 1, 1, 1".
  const rawMax = Math.max(...ys, 1);
  const step = Math.max(1, Math.ceil(rawMax / yTicks));
  const maxY = step * yTicks;
  const xScale = (i: number) => padding.left + (i / (data.length - 1)) * plotW;
  const yScale = (v: number) => padding.top + plotH - (v / maxY) * plotH;
  const linePath = data
    .map((d, i) => `${i === 0 ? 'M' : 'L'}${xScale(i).toFixed(1)},${yScale(d.cumulative).toFixed(1)}`)
    .join(' ');
  const areaPath = `${linePath} L${xScale(data.length - 1).toFixed(1)},${padding.top + plotH} L${xScale(0).toFixed(1)},${padding.top + plotH} Z`;

  const xTicks = Math.min(6, data.length - 1);

  return (
    <div className="chart">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="xMidYMid meet"
        style={{ width: '100%', height: 'auto', maxHeight: height }}
      >
        <defs>
          <linearGradient id="lc-grad" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.18" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        {Array.from({ length: yTicks + 1 }).map((_, i) => {
          const v = step * i;
          const y = yScale(v);
          return (
            <g key={`y-${i}`}>
              <line
                x1={padding.left}
                x2={width - padding.right}
                y1={y}
                y2={y}
                stroke="var(--rule-soft)"
                strokeWidth={1}
              />
              <text x={padding.left - 8} y={y + 3} textAnchor="end" className="chart-label">
                {v >= 1000 ? `${(v / 1000).toFixed(1)}k` : Math.round(v)}
              </text>
            </g>
          );
        })}
        {Array.from({ length: xTicks + 1 }).map((_, i) => {
          const idx = Math.round(((data.length - 1) / xTicks) * i);
          const x = xScale(idx);
          return (
            <text
              key={`x-${i}`}
              x={x}
              y={height - padding.bottom + 16}
              textAnchor="middle"
              className="chart-label"
            >
              {data[idx].h}
              {xUnit}
            </text>
          );
        })}
        <path d={areaPath} fill="url(#lc-grad)" />
        <path
          d={linePath}
          fill="none"
          stroke={color}
          strokeWidth={1.75}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}
