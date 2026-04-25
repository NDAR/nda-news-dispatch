// Subscribers view — roster + CSV import + tag management

const SUBSCRIBER_CSV_TEMPLATE =
  'email,name,org\n' +
  'jane.doe@example.edu,Jane Doe,Example University\n' +
  'alex.chen@nih.gov,Alex Chen,NIH\n';

function downloadSubscriberTemplate() {
  const blob = new Blob([SUBSCRIBER_CSV_TEMPLATE], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'nda-dispatch-subscribers-template.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

const SubscribersView = ({ subscribers, setSubscribers }) => {
  const [query, setQuery] = React.useState('');
  const [showImport, setShowImport] = React.useState(false);
  const [sortBy, setSortBy] = React.useState('joined');
  const [sortDir, setSortDir] = React.useState('desc');
  const [tagFilter, setTagFilter] = React.useState([]);
  const [selected, setSelected] = React.useState(new Set());
  const [showBulkTag, setShowBulkTag] = React.useState(false);
  const bulkRef = React.useRef(null);

  const active = subscribers.filter(s => s.status === 'active').length;
  const unsub = subscribers.filter(s => s.status === 'unsubscribed').length;
  const bounced = subscribers.filter(s => s.status === 'bounced').length;

  const filtered = subscribers.filter(s => {
    if (query) {
      const q = query.toLowerCase();
      if (!s.email.toLowerCase().includes(q) && !s.name.toLowerCase().includes(q) && !s.org.toLowerCase().includes(q)) return false;
    }
    if (tagFilter.length > 0) {
      const tags = s.tags || [];
      if (!tagFilter.every(t => tags.includes(t))) return false;
    }
    return true;
  });

  const sorted = [...filtered].sort((a, b) => {
    const dir = sortDir === 'asc' ? 1 : -1;
    if (sortBy === 'name') return a.name.localeCompare(b.name) * dir;
    if (sortBy === 'org') return a.org.localeCompare(b.org) * dir;
    return a.joined.localeCompare(b.joined) * dir;
  });

  const toggleSort = (col) => {
    if (sortBy === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortBy(col); setSortDir('asc'); }
  };

  const updateSubscriber = (updated) => {
    setSubscribers(subscribers.map(s => s.id === updated.id ? updated : s));
  };

  const toggleSelect = (id) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const applyBulkTag = (tagId) => {
    setSubscribers(subscribers.map(s => {
      if (!selected.has(s.id)) return s;
      const tags = s.tags || [];
      if (tags.includes(tagId)) return s;
      return { ...s, tags: [...tags, tagId] };
    }));
    setShowBulkTag(false);
  };

  // Tag count summary
  const tagCounts = {};
  subscribers.forEach(s => (s.tags || []).forEach(t => tagCounts[t] = (tagCounts[t] || 0) + 1));

  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="grid grid-4">
        <Metric label="Total subscribers" value={fmt(subscribers.length)} delta="+23 this month" deltaDir="up" />
        <Metric label="Active" value={fmt(active)} delta={pct(active, subscribers.length) + ' of list'} />
        <Metric label="Unsubscribed" value={fmt(unsub)} delta="last 90 days" />
        <Metric label="Bounced" value={fmt(bounced)} delta="will be suppressed" />
      </div>

      {/* Tag filter bar */}
      <div className="card">
        <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--rule-soft)' }}>
          <div className="row items-center justify-between mb-md">
            <div>
              <div className="eyebrow">Filter by tag</div>
              <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
                {tagFilter.length === 0
                  ? 'Showing all subscribers'
                  : `Showing subscribers with ${tagFilter.length === 1 ? 'tag' : 'all tags'}: ${tagFilter.map(t => window.getTag(t).label).join(', ')}`}
              </div>
            </div>
            {tagFilter.length > 0 && (
              <button className="btn btn-sm btn-ghost" onClick={() => setTagFilter([])}>
                <Icon name="x" size={12} /> Clear
              </button>
            )}
          </div>
          <TagFilter selected={tagFilter} onChange={setTagFilter} />
        </div>

        <div className="card-header">
          <div className="row items-center gap-md" style={{ flex: 1 }}>
            <div className="row items-center gap-sm" style={{
              border: '1px solid var(--rule)', borderRadius: 6, padding: '6px 10px', flex: 1, maxWidth: 320,
              background: 'var(--paper)',
            }}>
              <Icon name="search" size={14} />
              <input
                type="text"
                placeholder="Search name, email, institution…"
                value={query}
                onChange={e => setQuery(e.target.value)}
                style={{ border: 'none', outline: 'none', background: 'transparent', flex: 1, fontSize: 13, fontFamily: 'var(--sans)' }}
              />
            </div>
            <span className="muted" style={{ fontSize: 12 }}>
              {filtered.length} of {subscribers.length}
              {selected.size > 0 && <> · <strong style={{ color: 'var(--accent-deep)' }}>{selected.size} selected</strong></>}
            </span>
          </div>
          <div className="row gap-sm">
            {selected.size > 0 && (
              <div style={{ position: 'relative' }} ref={bulkRef}>
                <button className="btn btn-sm btn-primary" onClick={() => setShowBulkTag(o => !o)}>
                  <Icon name="plus" size={12} /> Tag {selected.size}
                </button>
                {showBulkTag && (
                  <TagPicker
                    current={[]}
                    anchorRef={bulkRef}
                    onClose={() => setShowBulkTag(false)}
                    onAdd={applyBulkTag}
                  />
                )}
              </div>
            )}
            <button className="btn btn-sm" onClick={downloadSubscriberTemplate} title="Download a CSV template with the expected columns">
              <Icon name="download" size={12} /> Template
            </button>
            <button className="btn btn-sm">
              <Icon name="download" size={12} /> Export
            </button>
            <button className="btn btn-sm btn-accent" onClick={() => setShowImport(true)}>
              <Icon name="upload" size={12} /> Import CSV
            </button>
          </div>
        </div>

        <div style={{ maxHeight: 540, overflow: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 32 }}>
                  <input type="checkbox"
                    checked={selected.size === sorted.length && sorted.length > 0}
                    onChange={e => {
                      if (e.target.checked) setSelected(new Set(sorted.slice(0, 80).map(s => s.id)));
                      else setSelected(new Set());
                    }}
                  />
                </th>
                <th style={{ cursor: 'pointer' }} onClick={() => toggleSort('name')}>
                  Name {sortBy === 'name' && (sortDir === 'asc' ? '↑' : '↓')}
                </th>
                <th style={{ cursor: 'pointer' }} onClick={() => toggleSort('org')}>
                  Institution {sortBy === 'org' && (sortDir === 'asc' ? '↑' : '↓')}
                </th>
                <th>Tags</th>
                <th style={{ cursor: 'pointer' }} onClick={() => toggleSort('joined')}>
                  Joined {sortBy === 'joined' && (sortDir === 'asc' ? '↑' : '↓')}
                </th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {sorted.slice(0, 80).map(s => (
                <tr key={s.id} style={selected.has(s.id) ? { background: 'oklch(from var(--accent) l c h / 0.05)' } : {}}>
                  <td>
                    <input type="checkbox" checked={selected.has(s.id)} onChange={() => toggleSelect(s.id)} />
                  </td>
                  <td>
                    <div className="row items-center gap-sm">
                      <Avatar name={s.name} size={24} />
                      <div>
                        <div>{s.name}</div>
                        <div className="mono-sm muted" style={{ fontSize: 11 }}>{s.email}</div>
                      </div>
                    </div>
                  </td>
                  <td>{s.org}</td>
                  <td style={{ minWidth: 220 }}>
                    <TagCell subscriber={s} onUpdate={updateSubscriber} />
                  </td>
                  <td className="muted">{fmtDate(s.joined)}</td>
                  <td>
                    {s.status === 'active' && <span className="pill sent"><span className="pill-dot"></span>Active</span>}
                    {s.status === 'unsubscribed' && <span className="pill draft"><span className="pill-dot"></span>Unsubscribed</span>}
                    {s.status === 'bounced' && <span className="pill" style={{ background: 'oklch(0.95 0.03 25)', color: 'oklch(0.45 0.10 25)' }}><span className="pill-dot" style={{ background: 'var(--bad)' }}></span>Bounced</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {sorted.length > 80 && (
            <div className="text-center muted" style={{ padding: 14, fontSize: 12, borderTop: '1px solid var(--rule-soft)' }}>
              Showing 80 of {sorted.length} · <a className="link-ghost">Load more</a>
            </div>
          )}
          {sorted.length === 0 && (
            <div className="text-center muted" style={{ padding: 40, fontSize: 13 }}>
              No subscribers match these filters.
            </div>
          )}
        </div>
      </div>

      {showImport && <ImportModal onClose={() => setShowImport(false)} onImport={(rows) => {
        const maxId = subscribers.length ? Math.max(...subscribers.map(s => s.id)) : 0;
        setSubscribers([...subscribers, ...rows.map((r, i) => ({ ...r, id: maxId + 1 + i, tags: [] }))]);
        setShowImport(false);
      }} />}
    </div>
  );
};

const ImportModal = ({ onClose, onImport }) => {
  const [stage, setStage] = React.useState('drop');
  const [fileName, setFileName] = React.useState('');
  const [rows, setRows] = React.useState([]);
  const [dragging, setDragging] = React.useState(false);
  const [assignTags, setAssignTags] = React.useState([]);

  const parseCSV = (text) => {
    const lines = text.trim().split('\n');
    const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
    return lines.slice(1).map(line => {
      const parts = line.split(',').map(p => p.trim());
      const obj = {};
      headers.forEach((h, i) => obj[h] = parts[i] || '');
      return {
        email: obj.email,
        name: obj.name || obj.email.split('@')[0],
        org: obj.org || obj.organization || obj.institution || '—',
        joined: new Date().toISOString().slice(0, 10),
        status: 'active',
        tags: [],
      };
    }).filter(r => r.email && r.email.includes('@'));
  };

  const handleFile = (file) => {
    if (!file) return;
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const parsed = parseCSV(e.target.result);
        setRows(parsed);
        setStage('preview');
      } catch (err) {
        alert('Could not parse CSV — please check the format.');
      }
    };
    reader.readAsText(file);
  };

  const loadSample = () => {
    const sample = `email,name,org
brennan.yu@columbia.edu,Brennan Yu,Columbia
sera.miller@nyu.edu,Sera Miller,NYU
k.okonkwo@princeton.edu,Kayode Okonkwo,Princeton
fumi.hashimoto@riken.jp,Fumi Hashimoto,RIKEN
owen.walsh@tcd.ie,Owen Walsh,Trinity College Dublin
n.arslan@uchicago.edu,Nil Arslan,U. Chicago
c.delacroix@epfl.ch,Céline Delacroix,EPFL
jay.rao@brown.edu,Jay Rao,Brown
lotta.berg@aalto.fi,Lotta Berg,Aalto
ibrahim.k@kaust.edu.sa,Ibrahim Khalil,KAUST
sarah.bram@vanderbilt.edu,Sarah Bram,Vanderbilt
d.okafor@rockefeller.edu,Dimeji Okafor,Rockefeller`;
    setFileName('sample_subscribers.csv');
    setRows(parseCSV(sample));
    setStage('preview');
  };

  const onConfirm = () => {
    const tagged = assignTags.length
      ? rows.map(r => ({ ...r, tags: [...new Set([...(r.tags || []), ...assignTags])] }))
      : rows;
    onImport(tagged);
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-lg" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div className="eyebrow">Import subscribers</div>
          <h2 className="serif mt-sm">Upload a CSV</h2>
        </div>
        <div className="modal-body">
          {stage === 'drop' && (
            <>
              <div
                className={`dropzone ${dragging ? 'dragging' : ''}`}
                onDragOver={e => { e.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={e => {
                  e.preventDefault();
                  setDragging(false);
                  handleFile(e.dataTransfer.files[0]);
                }}
                onClick={() => document.getElementById('csvfile').click()}
              >
                <input type="file" id="csvfile" accept=".csv" style={{ display: 'none' }}
                  onChange={e => handleFile(e.target.files[0])} />
                <Icon name="upload" size={28} />
                <div className="serif mt-sm" style={{ fontSize: 17 }}>
                  Drag a CSV here, or click to browse
                </div>
                <div className="muted mt-sm" style={{ fontSize: 13 }}>
                  Columns: <code className="mono-sm">email</code>, <code className="mono-sm">name</code>, <code className="mono-sm">org</code>
                </div>
              </div>
              <div className="text-center mt-md" style={{ display: 'flex', gap: 16, justifyContent: 'center' }}>
                <a className="link-ghost" onClick={downloadSubscriberTemplate}>Download template CSV</a>
                <span className="faint">·</span>
                <a className="link-ghost" onClick={loadSample}>or load a sample of 12 subscribers →</a>
              </div>
            </>
          )}

          {stage === 'preview' && (
            <>
              <div className="row items-center justify-between mb-md">
                <div>
                  <div className="serif" style={{ fontSize: 17 }}>
                    {rows.length} valid subscriber{rows.length === 1 ? '' : 's'}
                  </div>
                  <div className="muted mono-sm mt-sm">{fileName}</div>
                </div>
                <button className="btn btn-sm btn-ghost" onClick={() => { setStage('drop'); setRows([]); }}>
                  <Icon name="refresh" size={12} /> Choose different file
                </button>
              </div>

              <div className="row items-center justify-between" style={{ marginBottom: 6 }}>
                <div className="label" style={{ margin: 0 }}>Auto-tag these subscribers (optional)</div>
                {assignTags.length > 0 && (
                  <button className="btn btn-sm btn-ghost" onClick={() => setAssignTags([])} style={{ padding: '2px 8px' }}>
                    <Icon name="x" size={11} /> Clear
                  </button>
                )}
              </div>
              <div style={{ marginBottom: 14 }}>
                <TagFilter selected={assignTags} onChange={setAssignTags} />
              </div>
              <div className="muted" style={{ fontSize: 11.5, marginTop: -8, marginBottom: 14 }}>
                {assignTags.length === 0
                  ? 'No tags will be applied — subscribers import without tags.'
                  : `Each imported subscriber will be tagged with: ${assignTags.map(t => window.getTag(t).label).join(', ')}.`}
              </div>

              <div style={{ maxHeight: 220, overflow: 'auto', border: '1px solid var(--rule)', borderRadius: 6 }}>
                <table className="table" style={{ fontSize: 12 }}>
                  <thead>
                    <tr><th>Email</th><th>Name</th><th>Institution</th></tr>
                  </thead>
                  <tbody>
                    {rows.slice(0, 20).map((r, i) => (
                      <tr key={i}>
                        <td className="mono-sm">{r.email}</td>
                        <td>{r.name}</td>
                        <td>{r.org}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {rows.length > 20 && (
                  <div className="text-center muted" style={{ padding: 10, fontSize: 11, borderTop: '1px solid var(--rule-soft)' }}>
                    …and {rows.length - 20} more
                  </div>
                )}
              </div>
            </>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn" onClick={onClose}>Cancel</button>
          {stage === 'preview' && (
            <button className="btn btn-accent" onClick={onConfirm}>
              <Icon name="check" size={12} /> Import {rows.length} subscribers
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

window.SubscribersView = SubscribersView;
