// Tag utilities & components

const getTag = (id) => (window.TAG_CATALOG || []).find(t => t.id === id) || { id, label: id, hue: 60 };

const TagPill = ({ tagId, onRemove, size = 'md' }) => {
  const tag = getTag(tagId);
  const padding = size === 'sm' ? '1px 7px 1px 8px' : '2px 9px 2px 10px';
  const fs = size === 'sm' ? 10 : 11;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding, fontSize: fs, lineHeight: 1.4,
      background: `oklch(0.95 0.035 ${tag.hue})`,
      color: `oklch(0.38 0.10 ${tag.hue})`,
      border: `1px solid oklch(0.88 0.05 ${tag.hue})`,
      borderRadius: 99,
      fontFamily: 'var(--sans)',
      fontWeight: 500,
      whiteSpace: 'nowrap',
    }}>
      <span style={{
        width: 5, height: 5, borderRadius: '50%',
        background: `oklch(0.55 0.14 ${tag.hue})`,
      }} />
      {tag.label}
      {onRemove && (
        <button
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          style={{
            border: 'none', background: 'transparent', cursor: 'pointer',
            padding: 0, marginLeft: 2, display: 'grid', placeItems: 'center',
            color: `oklch(0.45 0.08 ${tag.hue})`, opacity: 0.6,
          }}
          title="Remove tag"
        >
          <svg width="9" height="9" viewBox="0 0 10 10"><path d="M1 1L9 9M9 1L1 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>
        </button>
      )}
    </span>
  );
};

// Popover for adding tags to a subscriber
const TagPicker = ({ current, onAdd, onClose, anchorRef }) => {
  const popRef = React.useRef(null);
  // Position the popover in viewport coordinates and render via portal so it
  // can't be clipped by any scrollable ancestor (e.g. the subscribers table
  // wrapper's overflow:auto).
  const [pos, setPos] = React.useState({ top: 0, left: 0, openUp: false, width: 220 });

  React.useLayoutEffect(() => {
    const anchor = anchorRef?.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const width = Math.max(220, rect.width);
    const approxHeight = 44 + Math.min(window.TAG_CATALOG.length, 8) * 32;
    const spaceBelow = window.innerHeight - rect.bottom;
    const openUp = spaceBelow < approxHeight + 16 && rect.top > approxHeight + 16;
    const top = openUp ? rect.top - approxHeight - 4 : rect.bottom + 4;
    const left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8);
    setPos({ top, left, openUp, width });
  }, [anchorRef]);

  React.useEffect(() => {
    const handler = (e) => {
      if (popRef.current && !popRef.current.contains(e.target) &&
          anchorRef?.current && !anchorRef.current.contains(e.target)) {
        onClose();
      }
    };
    const onScrollOrResize = () => onClose();
    setTimeout(() => document.addEventListener('mousedown', handler), 0);
    window.addEventListener('resize', onScrollOrResize);
    window.addEventListener('scroll', onScrollOrResize, true);
    return () => {
      document.removeEventListener('mousedown', handler);
      window.removeEventListener('resize', onScrollOrResize);
      window.removeEventListener('scroll', onScrollOrResize, true);
    };
  }, []);

  const available = window.TAG_CATALOG.filter(t => !current.includes(t.id));

  return ReactDOM.createPortal(
    <div ref={popRef} style={{
      position: 'fixed', top: pos.top, left: pos.left,
      zIndex: 2000, minWidth: pos.width,
      background: 'var(--paper)',
      border: '1px solid var(--rule)', borderRadius: 8,
      boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
      padding: 6,
    }}>
      <div style={{ fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--ink-mute)', padding: '6px 8px 4px' }}>
        Add tag
      </div>
      {available.length === 0 && (
        <div style={{ padding: '8px 10px', fontSize: 12, color: 'var(--ink-mute)' }}>All tags already applied</div>
      )}
      {available.map(t => (
        <button
          key={t.id}
          onClick={() => { onAdd(t.id); }}
          style={{
            display: 'flex', alignItems: 'center', gap: 8,
            width: '100%', padding: '6px 8px',
            border: 'none', background: 'transparent',
            cursor: 'pointer', textAlign: 'left',
            borderRadius: 5, fontFamily: 'var(--sans)', fontSize: 13,
            color: 'var(--ink)',
          }}
          onMouseEnter={e => e.currentTarget.style.background = 'var(--paper-deep)'}
          onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
        >
          <span style={{
            width: 8, height: 8, borderRadius: '50%',
            background: `oklch(0.55 0.14 ${t.hue})`,
          }} />
          {t.label}
        </button>
      ))}
    </div>,
    document.body,
  );
};

// Cell component rendering subscriber tags
const TagCell = ({ subscriber, onUpdate }) => {
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const btnRef = React.useRef(null);
  const tags = subscriber.tags || [];

  return (
    <div className="row items-center" style={{ gap: 4, flexWrap: 'wrap', position: 'relative' }}>
      {tags.map(t => (
        <TagPill key={t} tagId={t} size="sm"
          onRemove={() => onUpdate({ ...subscriber, tags: tags.filter(x => x !== t) })}
        />
      ))}
      <button
        ref={btnRef}
        onClick={(e) => { e.stopPropagation(); setPickerOpen(o => !o); }}
        style={{
          border: '1px dashed var(--rule)', borderRadius: 99,
          background: 'transparent', color: 'var(--ink-faint)',
          padding: '2px 8px', fontSize: 10, cursor: 'pointer',
          display: 'inline-flex', alignItems: 'center', gap: 3,
          fontFamily: 'var(--sans)',
        }}
        title="Add tag"
      >
        + tag
      </button>
      {pickerOpen && (
        <TagPicker
          current={tags}
          anchorRef={btnRef}
          onClose={() => setPickerOpen(false)}
          onAdd={(tagId) => {
            onUpdate({ ...subscriber, tags: [...tags, tagId] });
            setPickerOpen(false);
          }}
        />
      )}
    </div>
  );
};

// Multi-select filter for tags (used in subscribers view and send flow)
const TagFilter = ({ selected, onChange, mode = 'any' }) => {
  return (
    <div className="row items-center" style={{ gap: 6, flexWrap: 'wrap' }}>
      {window.TAG_CATALOG.map(t => {
        const active = selected.includes(t.id);
        return (
          <button
            key={t.id}
            onClick={() => onChange(active ? selected.filter(x => x !== t.id) : [...selected, t.id])}
            style={{
              padding: '4px 10px', fontSize: 11.5,
              background: active ? `oklch(0.92 0.06 ${t.hue})` : 'var(--paper)',
              color: active ? `oklch(0.32 0.12 ${t.hue})` : 'var(--ink-soft)',
              border: `1px solid ${active ? `oklch(0.78 0.08 ${t.hue})` : 'var(--rule)'}`,
              borderRadius: 99, cursor: 'pointer',
              fontFamily: 'var(--sans)', fontWeight: active ? 500 : 400,
              display: 'inline-flex', alignItems: 'center', gap: 5,
              transition: 'all 0.12s',
            }}
          >
            <span style={{
              width: 6, height: 6, borderRadius: '50%',
              background: `oklch(0.55 0.14 ${t.hue})`,
              opacity: active ? 1 : 0.5,
            }} />
            {t.label}
          </button>
        );
      })}
    </div>
  );
};

Object.assign(window, { getTag, TagPill, TagPicker, TagCell, TagFilter });
