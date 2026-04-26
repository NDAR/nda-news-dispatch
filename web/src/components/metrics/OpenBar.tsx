interface OpenBarProps {
  /** Open rate as a fraction (0..1). NaN/Infinity render as zero-width. */
  rate: number;
}

export function OpenBar({ rate }: OpenBarProps) {
  const safe = Number.isFinite(rate) && rate > 0 ? rate : 0;
  const w = Math.max(safe ? 4 : 0, Math.min(100, safe * 100));
  return (
    <div
      style={{
        width: 60,
        height: 3,
        background: 'var(--rule-soft)',
        borderRadius: 2,
        marginTop: 3,
      }}
    >
      <div
        style={{
          width: `${w}%`,
          height: '100%',
          background: 'var(--accent)',
          borderRadius: 2,
        }}
      />
    </div>
  );
}
