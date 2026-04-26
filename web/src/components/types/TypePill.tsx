import type { NewsletterType } from '../../api/endpoints';

interface TypePillProps {
  type: NewsletterType | undefined;
  size?: 'sm' | 'md';
}

/**
 * Renders a colored pill for a newsletter type. The hue is stored on the type
 * record; lightness/chroma are picked here so backgrounds and text are always
 * legible across user-chosen hues. When no type is provided (e.g. an older
 * untyped template), a neutral muted pill is shown instead of nothing — that
 * way the column position stays stable in tables.
 */
export function TypePill({ type, size = 'sm' }: TypePillProps) {
  const fontSize = size === 'md' ? 12 : 11;
  if (!type) {
    return (
      <span
        className="pill"
        style={{
          fontSize,
          background: 'var(--paper-deep)',
          color: 'var(--ink-mute)',
          border: '1px solid var(--rule)',
        }}
      >
        Untyped
      </span>
    );
  }
  const hue = type.color;
  return (
    <span
      className="pill"
      title={type.description || type.name}
      style={{
        fontSize,
        background: `oklch(0.94 0.05 ${hue})`,
        color: `oklch(0.35 0.10 ${hue})`,
        border: `1px solid oklch(0.85 0.06 ${hue})`,
      }}
    >
      {type.archived && <span style={{ opacity: 0.6, marginRight: 4 }}>⌫</span>}
      {type.name}
    </span>
  );
}

/**
 * Small color swatch for use in pickers — same hue formula, no label.
 */
export function TypeSwatch({ hue, size = 14 }: { hue: number; size?: number }) {
  return (
    <span
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        borderRadius: '50%',
        background: `oklch(0.65 0.16 ${hue})`,
        border: `1px solid oklch(0.50 0.14 ${hue})`,
        verticalAlign: 'middle',
      }}
    />
  );
}
