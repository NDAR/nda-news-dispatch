import type { ReactNode } from 'react';

interface MetricProps {
  label: string;
  value: ReactNode;
  delta?: ReactNode;
  deltaDir?: 'up' | 'down';
  spark?: ReactNode;
}

export function Metric({ label, value, delta, deltaDir, spark }: MetricProps) {
  return (
    <div className="metric">
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
