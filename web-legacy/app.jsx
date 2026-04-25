// Main app shell — nav + routing; supports multiple drafts

const { useState, useEffect } = React;

const NAV_ITEMS = [
  { id: 'compose', label: 'Compose', icon: 'compose' },
  { id: 'subscribers', label: 'Subscribers', icon: 'users' },
  { id: 'send', label: 'Send', icon: 'send' },
  { id: 'history', label: 'History', icon: 'history' },
];

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "accentHue": 45,
  "density": "cozy",
  "editorRatio": 50,
  "editorOrient": "horizontal"
}/*EDITMODE-END*/;

const App = () => {
  const [view, setView] = useState('compose');
  const [subscribers, setSubscribers] = useState(window.SAMPLE_SUBSCRIBERS);
  const [newsletters, setNewsletters] = useState(window.PAST_NEWSLETTERS);
  const [drafts, setDrafts] = useState(window.SAMPLE_DRAFTS);
  const [currentDraftId, setCurrentDraftId] = useState(window.SAMPLE_DRAFTS[0].id);
  const [sentInfo, setSentInfo] = useState(null);
  const [tweaks, setTweak] = window.useTweaks(TWEAK_DEFAULTS);

  const currentDraft = drafts.find(d => d.id === currentDraftId) || drafts[0];

  useEffect(() => {
    document.documentElement.style.setProperty('--accent', `oklch(0.55 0.12 ${tweaks.accentHue})`);
    document.documentElement.style.setProperty('--accent-soft', `oklch(0.92 0.04 ${tweaks.accentHue})`);
    document.documentElement.style.setProperty('--accent-deep', `oklch(0.42 0.11 ${tweaks.accentHue})`);
    document.documentElement.dataset.density = tweaks.density;
  }, [tweaks]);

  const handleSent = (info) => {
    const newEntry = info.when === 'schedule' ? {
      id: 'n' + (newsletters.length + 48),
      subject: info.subject, sentAt: `${info.scheduleDate}T${info.scheduleTime}`,
      recipients: info.count, delivered: 0, opened: 0, clicked: 0, unsubscribed: 0, bounced: 0,
      status: 'scheduled', tags: info.tags,
    } : {
      id: 'n' + (newsletters.length + 48),
      subject: info.subject, sentAt: new Date().toISOString().slice(0, 16),
      recipients: info.count,
      delivered: Math.floor(info.count * 0.985),
      opened: Math.floor(info.count * 0.68),
      clicked: Math.floor(info.count * 0.24),
      unsubscribed: Math.floor(info.count * 0.002),
      bounced: info.count - Math.floor(info.count * 0.985),
      status: 'sent', tags: info.tags,
    };
    setNewsletters([newEntry, ...newsletters]);
    setSentInfo(info);
  };

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">NDA<span className="brand-dot"></span></span>
        </div>
        <div style={{ padding: '0 6px', marginTop: -18 }}>
          <span className="brand-sub">Dispatch</span>
        </div>

        <nav className="nav">
          <div className="nav-section-label">Workspace</div>
          {NAV_ITEMS.map(item => (
            <button
              key={item.id}
              className={`nav-item ${view === item.id ? 'active' : ''}`}
              onClick={() => setView(item.id)}
            >
              <Icon name={item.icon} size={15} />
              {item.label}
              {item.id === 'compose' && (
                <span style={{
                  marginLeft: 'auto',
                  fontSize: 10, padding: '2px 6px',
                  background: view === 'compose' ? 'rgba(255,255,255,0.15)' : 'var(--accent-soft)',
                  color: view === 'compose' ? 'var(--paper)' : 'var(--accent-deep)',
                  borderRadius: 99,
                  fontFamily: 'var(--mono)',
                }}>{drafts.length}</span>
              )}
            </button>
          ))}
        </nav>

        <div className="sidebar-footer">
          <Avatar name="Mina Reyes" size={28} />
          <div className="stack" style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12, color: 'var(--ink-soft)', fontWeight: 500 }}>Mina Reyes</div>
            <div style={{ fontSize: 11, color: 'var(--ink-faint)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              Communications · NIMH
            </div>
          </div>
        </div>
      </aside>

      <main className="main">
        <TopBar view={view} subscribers={subscribers} drafts={drafts} />
        <div className="content" data-screen-label={viewLabel(view)}>
          {view === 'compose' && (
            <ComposeView
              drafts={drafts} setDrafts={setDrafts}
              currentDraftId={currentDraftId} setCurrentDraftId={setCurrentDraftId}
              editorRatio={tweaks.editorRatio}
              editorOrient={tweaks.editorOrient}
              onSendDraft={(id) => { setCurrentDraftId(id); setView('send'); }}
            />
          )}
          {view === 'subscribers' && (
            <SubscribersView subscribers={subscribers} setSubscribers={setSubscribers} />
          )}
          {view === 'send' && (
            <SendView
              subscribers={subscribers}
              draft={currentDraft}
              onSent={handleSent}
              onBack={() => setView('compose')}
            />
          )}
          {view === 'history' && (
            <HistoryView newsletters={newsletters} density={tweaks.density} />
          )}
        </div>
      </main>

      {sentInfo && (
        <SentModal info={sentInfo} onClose={() => { setSentInfo(null); setView('history'); }} />
      )}

      <TweaksUI tweaks={tweaks} setTweak={setTweak} />
    </div>
  );
};

const viewLabel = (v) => ({
  compose: 'Compose',
  subscribers: 'Subscribers',
  send: 'Send',
  history: 'History',
}[v]);

const TopBar = ({ view, subscribers, drafts }) => {
  const titles = {
    compose: { eyebrow: 'Workspace', title: 'Compose', sub: `${drafts.length} newsletter${drafts.length === 1 ? '' : 's'} in progress` },
    subscribers: { eyebrow: 'Audience', title: 'Subscribers', sub: `${subscribers.length.toLocaleString()} on the list` },
    send: { eyebrow: 'Delivery', title: 'Send', sub: 'Review and deliver your dispatch' },
    history: { eyebrow: 'Archive', title: 'History', sub: 'Past sends and engagement' },
  };
  const t = titles[view];
  return (
    <div className="topbar">
      <div className="topbar-title">
        <span className="eyebrow">{t.eyebrow}</span>
        <h2 className="serif">{t.title} <span className="muted" style={{ fontSize: 15, fontStyle: 'italic', marginLeft: 6 }}>— {t.sub}</span></h2>
      </div>
      <div className="topbar-actions">
        <button className="btn btn-sm btn-ghost"><Icon name="inbox" size={13} /></button>
        <button className="btn btn-sm btn-ghost"><Icon name="settings" size={13} /></button>
      </div>
    </div>
  );
};

const TweaksUI = ({ tweaks, setTweak }) => {
  const { TweaksPanel, TweakSection, TweakSlider, TweakRadio } = window;
  return (
    <TweaksPanel>
      <TweakSection label="Appearance">
        <TweakSlider
          label="Accent hue"
          value={tweaks.accentHue}
          min={0} max={360} step={1}
          unit="°"
          onChange={v => setTweak('accentHue', v)}
        />
        <TweakRadio
          label="Dashboard density"
          value={tweaks.density}
          options={[{ value: 'cozy', label: 'Cozy' }, { value: 'compact', label: 'Compact' }]}
          onChange={v => setTweak('density', v)}
        />
      </TweakSection>

      <TweakSection label="Editor">
        <TweakSlider
          label="Split ratio"
          value={tweaks.editorRatio}
          min={25} max={75} step={1}
          unit="%"
          onChange={v => setTweak('editorRatio', v)}
        />
        <TweakRadio
          label="Orientation"
          value={tweaks.editorOrient}
          options={[{ value: 'horizontal', label: 'Side' }, { value: 'vertical', label: 'Stacked' }]}
          onChange={v => setTweak('editorOrient', v)}
        />
      </TweakSection>
    </TweaksPanel>
  );
};

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
