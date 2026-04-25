// Compose view — list of drafts + split editor

const ComposeView = ({ drafts, setDrafts, currentDraftId, setCurrentDraftId, editorRatio, editorOrient, onSendDraft }) => {
  const draft = drafts.find(d => d.id === currentDraftId) || drafts[0];
  const iframeRef = React.useRef(null);
  const [collapsed, setCollapsed] = React.useState(false);

  React.useEffect(() => {
    if (iframeRef.current && draft) {
      const doc = iframeRef.current.contentDocument;
      doc.open();
      doc.write(draft.html);
      doc.close();
    }
  }, [draft?.html, draft?.id]);

  const updateDraft = (patch) => {
    setDrafts(drafts.map(d => d.id === draft.id ? { ...d, ...patch, updatedAt: new Date().toISOString().slice(0, 16) } : d));
  };

  const newDraft = () => {
    const id = 'd' + Date.now();
    const created = {
      id,
      title: 'Untitled newsletter',
      subject: '',
      html: window.DEFAULT_HTML,
      updatedAt: new Date().toISOString().slice(0, 16),
      targetTags: [],
    };
    setDrafts([created, ...drafts]);
    setCurrentDraftId(id);
  };

  const duplicateDraft = () => {
    const id = 'd' + Date.now();
    const dup = {
      ...draft,
      id,
      title: draft.title + ' (copy)',
      updatedAt: new Date().toISOString().slice(0, 16),
    };
    setDrafts([dup, ...drafts]);
    setCurrentDraftId(id);
  };

  const deleteDraft = () => {
    if (drafts.length <= 1) { alert('You must have at least one draft.'); return; }
    if (!confirm(`Delete "${draft.title}"?`)) return;
    const next = drafts.filter(d => d.id !== draft.id);
    setDrafts(next);
    setCurrentDraftId(next[0].id);
  };

  const gridTemplate = editorOrient === 'vertical'
    ? { gridTemplateRows: `${editorRatio}fr ${100 - editorRatio}fr`, gridTemplateColumns: '1fr' }
    : { gridTemplateColumns: `${editorRatio}fr ${100 - editorRatio}fr`, gridTemplateRows: '1fr' };

  if (!draft) return <div className="muted">No drafts. <a className="link-ghost" onClick={newDraft}>Create one →</a></div>;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: collapsed ? '44px 1fr' : '280px 1fr', gap: 20, alignItems: 'start' }}>
      {/* Drafts sidebar */}
      <div className="card" style={{ position: 'sticky', top: 88, maxHeight: 'calc(100vh - 120px)', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {collapsed ? (
          <button className="btn btn-ghost btn-icon" onClick={() => setCollapsed(false)} style={{ margin: 6 }}>
            <Icon name="arrowright" size={14} />
          </button>
        ) : (
          <>
            <div style={{ padding: '14px 14px 10px', borderBottom: '1px solid var(--rule-soft)' }}>
              <div className="row items-center justify-between">
                <div className="eyebrow">Newsletters</div>
                <button className="btn btn-ghost btn-icon" onClick={() => setCollapsed(true)} title="Collapse">
                  <Icon name="arrowleft" size={13} />
                </button>
              </div>
              <button className="btn btn-primary btn-sm" onClick={newDraft} style={{ width: '100%', marginTop: 10, justifyContent: 'center' }}>
                <Icon name="plus" size={12} /> New newsletter
              </button>
            </div>
            <div style={{ overflow: 'auto', flex: 1 }}>
              {drafts.map(d => {
                const active = d.id === draft.id;
                return (
                  <button
                    key={d.id}
                    onClick={() => setCurrentDraftId(d.id)}
                    style={{
                      display: 'block', width: '100%', textAlign: 'left',
                      padding: '12px 14px', border: 'none',
                      borderBottom: '1px solid var(--rule-soft)',
                      background: active ? 'var(--paper-deep)' : 'transparent',
                      borderLeft: active ? '2px solid var(--accent)' : '2px solid transparent',
                      cursor: 'pointer',
                    }}
                  >
                    <div className="serif" style={{ fontSize: 14, lineHeight: 1.3, color: 'var(--ink)', fontWeight: active ? 500 : 400 }}>
                      {d.title}
                    </div>
                    {d.subject && (
                      <div className="muted" style={{ fontSize: 11.5, marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {d.subject}
                      </div>
                    )}
                    <div className="row items-center" style={{ gap: 4, marginTop: 6, flexWrap: 'wrap' }}>
                      {(d.targetTags || []).length === 0 ? (
                        <span style={{ fontSize: 10, color: 'var(--ink-faint)', fontFamily: 'var(--sans)' }}>
                          All subscribers
                        </span>
                      ) : (
                        (d.targetTags || []).slice(0, 2).map(t => <TagPill key={t} tagId={t} size="sm" />)
                      )}
                      {(d.targetTags || []).length > 2 && (
                        <span style={{ fontSize: 10, color: 'var(--ink-mute)' }}>+{d.targetTags.length - 2}</span>
                      )}
                    </div>
                    <div className="muted" style={{ fontSize: 10, marginTop: 6, fontFamily: 'var(--mono)' }}>
                      {fmtRel(d.updatedAt)}
                    </div>
                  </button>
                );
              })}
            </div>
          </>
        )}
      </div>

      {/* Editor column */}
      <div className="stack" style={{ gap: 16 }}>
        <div className="card">
          <div className="card-body" style={{ padding: 16 }}>
            <div className="row items-center gap-md" style={{ marginBottom: 12 }}>
              <div style={{ flex: 1 }}>
                <div className="label">Newsletter title <span className="faint" style={{ fontSize: 10, marginLeft: 6, textTransform: 'none', letterSpacing: 0 }}>(internal — not sent)</span></div>
                <input
                  className="input"
                  value={draft.title}
                  onChange={e => updateDraft({ title: e.target.value })}
                  placeholder="e.g. Monthly dispatch — May"
                  style={{ fontFamily: 'var(--serif)', fontSize: 16, padding: '10px 12px' }}
                />
              </div>
              <div className="row gap-sm">
                <button className="btn btn-sm" onClick={duplicateDraft} title="Duplicate">
                  <Icon name="refresh" size={12} /> Duplicate
                </button>
                <button className="btn btn-sm" onClick={deleteDraft} title="Delete" style={{ color: 'var(--bad)' }}>
                  <Icon name="trash" size={12} />
                </button>
              </div>
            </div>

            <div className="row items-center gap-md">
              <div style={{ flex: 1 }}>
                <div className="label">Subject line</div>
                <input
                  className="input"
                  value={draft.subject}
                  onChange={e => updateDraft({ subject: e.target.value })}
                  placeholder="Subject line shown in recipients' inbox"
                  style={{ fontFamily: 'var(--serif)', fontSize: 15, padding: '10px 12px' }}
                />
              </div>
              <div style={{ minWidth: 200 }}>
                <div className="label">From</div>
                <div className="input" style={{ background: 'var(--paper-deep)', cursor: 'not-allowed', fontSize: 12.5 }}>
                  NDA Dispatch &lt;dispatch@nda.nih.gov&gt;
                </div>
              </div>
            </div>

            <div style={{ marginTop: 12 }}>
              <div className="label">Default audience
                <span className="faint" style={{ fontSize: 10, marginLeft: 6, textTransform: 'none', letterSpacing: 0 }}>
                  (subscribers must have ALL selected tags — editable at send time)
                </span>
              </div>
              <TagFilter
                selected={draft.targetTags || []}
                onChange={(tags) => updateDraft({ targetTags: tags })}
              />
            </div>
          </div>
        </div>

        <div className="split" style={gridTemplate}>
          <div className="split-pane">
            <div className="split-pane-header">
              <div className="row items-center gap-sm">
                <Icon name="code" size={14} />
                <span className="mono-sm">{draft.id}.html</span>
              </div>
              <div className="row items-center gap-sm">
                <span className="faint mono-sm">{draft.html.length.toLocaleString()} chars</span>
                <span className="pulse" title="Live"></span>
              </div>
            </div>
            <div className="split-pane-body">
              <textarea
                className="code-editor"
                value={draft.html}
                onChange={e => updateDraft({ html: e.target.value })}
                spellCheck={false}
              />
            </div>
          </div>

          <div className="split-pane">
            <div className="split-pane-header">
              <div className="row items-center gap-sm">
                <Icon name="eye" size={14} />
                <span className="mono-sm">Preview</span>
              </div>
              <div className="segmented">
                <button className="active">Desktop</button>
                <button>Mobile</button>
              </div>
            </div>
            <div className="split-pane-body preview-shell">
              <iframe ref={iframeRef} className="preview-page" style={{ border: 'none' }} title="preview" />
            </div>
          </div>
        </div>

        <div className="row items-center justify-between" style={{ paddingTop: 4 }}>
          <div className="muted" style={{ fontSize: 13 }}>
            <Icon name="check" size={12} /> &nbsp;Draft saved automatically · <span className="faint">last edit {fmtRel(draft.updatedAt)}</span>
          </div>
          <div className="row gap-sm">
            <button className="btn">Send test to yourself</button>
            <button className="btn btn-accent" onClick={() => onSendDraft(draft.id)}>
              <Icon name="send" size={13} /> Continue to send
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

window.ComposeView = ComposeView;
