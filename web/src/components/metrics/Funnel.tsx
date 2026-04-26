import { formatNumber } from '../../lib/format';

export interface FunnelStep {
  label: string;
  value: number;
}

interface FunnelProps {
  /** First step is treated as 100% and used as the denominator for all bars. */
  steps: FunnelStep[];
}

export function Funnel({ steps }: FunnelProps) {
  const max = steps[0]?.value ?? 0;
  return (
    <div className="stack" style={{ gap: 10 }}>
      {steps.map((s, i) => {
        const pct = max > 0 ? (s.value / max) * 100 : 0;
        return (
          <div key={s.label}>
            <div
              className="row justify-between items-center"
              style={{ fontSize: 13, marginBottom: 4 }}
            >
              <span className="serif">{s.label}</span>
              <span>
                <span className="mono-sm">{formatNumber(s.value)}</span>{' '}
                <span className="muted mono-sm">({pct.toFixed(1)}%)</span>
              </span>
            </div>
            <div
              style={{
                height: 8,
                background: 'var(--paper-deep)',
                borderRadius: 4,
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  width: `${pct}%`,
                  height: '100%',
                  background: `oklch(from var(--accent) calc(l + ${i * 0.04}) c h)`,
                  borderRadius: 4,
                  transition: 'width 0.4s',
                }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
