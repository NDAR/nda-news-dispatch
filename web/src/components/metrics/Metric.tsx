import type { ReactNode } from 'react';

interface MetricProps {
  label: string;
  value: ReactNode;
  delta?: ReactNode;
  deltaDir?: 'up' | 'down';
  spark?: ReactNode;
  onClick?: () => void;
}

export function Metric({ label, value, delta, deltaDir, spark, onClick }: MetricProps) {
  const interactive = !!onClick;
  return (
    <div
      className="metric"
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      onClick={onClick}
      onKeyDown={
        interactive
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onClick!();
              }
            }
          : undefined
      }
      style={interactive ? { cursor: 'pointer' } : undefined}
      title={interactive ? 'Click to see trend over time' : undefined}
    >
      <div className="metric-label">{label}</div>
      <div className="row items-end justify-between" style={{ gap: 12 }}>
        <div className="metric-value">{value}</div>
        {spark && <div style={{ flex: '0 0 auto' }}>{spark}</div>}
      </div>
      {delta !== undefined && delta !== null && delta !== '' && (
        <div className={`metric-delta ${deltaDir ?? ''}`}>{delta}</div>
      )}
    </div>
  );
}
