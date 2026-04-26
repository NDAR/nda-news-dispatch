export function formatNumber(n: number): string {
  return n.toLocaleString();
}

/**
 * Returns "—" when the denominator is zero so callers don't have to special-case
 * unsent campaigns. Always rounds to 1 decimal except when the rate is exactly
 * 100% (e.g. delivered === recipients), where the integer reads cleaner.
 */
export function formatPct(num: number, den: number): string {
  if (!den) return '—';
  const r = (num / den) * 100;
  if (r === 100) return '100%';
  return `${r.toFixed(1)}%`;
}

export function formatRel(iso: string | undefined | null): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const diff = t - Date.now();
  const abs = Math.abs(diff);
  const min = Math.round(abs / 60_000);
  const past = diff < 0;
  if (min < 1) return past ? 'just now' : 'in <1 min';
  if (min < 60) return past ? `${min} min ago` : `in ${min} min`;
  const hr = Math.round(min / 60);
  if (hr < 24) return past ? `${hr} hr ago` : `in ${hr} hr`;
  const day = Math.round(hr / 24);
  return past ? `${day} day${day === 1 ? '' : 's'} ago` : `in ${day} day${day === 1 ? '' : 's'}`;
}

export function formatDate(iso: string | undefined | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function formatDateTime(iso: string | undefined | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
