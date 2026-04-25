// Send view — recipients (tag-filtered), scheduling, confirmation

const SendView = ({ subscribers, draft, onSent, onBack, onUpdateDraft }) => {
  const [step, setStep] = React.useState(1);
  const [when, setWhen] = React.useState('now');
  const [scheduleDate, setScheduleDate] = React.useState('2026-04-29');
  const [scheduleTime, setScheduleTime] = React.useState('09:00');
  const [tagMode, setTagMode] = React.useState('all'); // all | any | none
  const [selectedTags, setSelectedTags] = React.useState(draft?.targetTags || []);
  const [excludeTags, setExcludeTags] = React.useState([]);

  const active = subscribers.filter(s => s.status === 'active');

  const matchesTags = (s) => {
    const tags = s.tags || [];
    if (excludeTags.length > 0 && excludeTags.some(t => tags.includes(t))) return false;
    if (selectedTags.length === 0) return true;
    if (tagMode === 'all') return selectedTags.every(t => tags.includes(t));
    if (tagMode === 'any') return selectedTags.some(t => tags.includes(t));
    return true;
  };

  const recipients = active.filter(matchesTags);
  const recipientCount = recipients.length;

  // Breakdown by primary tag for preview
  const tagBreakdown = {};
  recipients.forEach(s => {
    (s.tags || []).forEach(t => { tagBreakdown[t] = (tagBreakdown[t] || 0) + 1; });
  });
  const topTags = Object.entries(tagBreakdown).sort((a, b) => b[1] - a[1]).slice(0, 5);

  return (
    <div className="stack" style={{ gap: 24, maxWidth: 860 }}>
      <div className="card" style={{ background: 'var(--paper-deep)' }}>
        <div className="card-body" style={{ padding: '14px 18px' }}>
          <div className="row items-center gap-md">
            <div style={{ flex: 1 }}>
              <div className="eyebrow">Sending</div>
              <div className="serif" style={{ fontSize: 17, marginTop: 2 }}>{draft?.title || 'Untitled'}</div>
              <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>
                <strong style={{ color: 'var(--ink-soft)', fontWeight: 500 }}>Subject:</strong> {draft?.subject || <em className="faint">(no subject yet)</em>}
              </div>
            </div>
            <button className="btn btn-sm" onClick={onBack}>
              <Icon name="edit" size={12} /> Edit content
            </button>
          </div>
        </div>
      </div>

      {/* Stepper */}
      <div className="row items-center gap-md" style={{ padding: '6px 0' }}>
        {['Recipients', 'Timing', 'Review & send'].map((label, i) => {
          const idx = i + 1;
          const active = step === idx;
          const done = step > idx;
          return (
            <React.Fragment key={label}>
              <div className="row items-center gap-sm" style={{ opacity: active || done ? 1 : 0.5 }}>
                <div style={{
                  width: 26, height: 26, borderRadius: '50%',
                  background: done ? 'var(--good)' : active ? 'var(--ink)' : 'var(--paper-deep)',
                  color: done || active ? 'var(--paper)' : 'var(--ink-mute)',
                  display: 'grid', placeItems: 'center',
                  fontFamily: 'var(--serif)', fontSize: 13, fontWeight: 500,
                  border: done || active ? 'none' : '1px solid var(--rule)',
                }}>
                  {done ? <Icon name="check" size={12} /> : idx}
                </div>
                <span className="serif" style={{ fontSize: 15 }}>{label}</span>
              </div>
              {idx < 3 && <div style={{ flex: 1, height: 1, background: 'var(--rule)' }} />}
            </React.Fragment>
          );
        })}
      </div>

      {step === 1 && (
        <div className="card">
          <div className="card-header">
            <div>
              <div className="eyebrow">Step 1</div>
              <h3 className="serif mt-sm">Filter by tag</h3>
            </div>
            <div className="text-right">
              <div className="serif" style={{ fontSize: 26, lineHeight: 1 }}>{fmt(recipientCount)}</div>
              <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>recipients</div>
            </div>
          </div>
          <div className="card-body">
            <div className="label">Include subscribers with</div>
            <div className="row items-center gap-sm" style={{ marginBottom: 10 }}>
              <div className="segmented">
                <button className={tagMode === 'all' ? 'active' : ''} onClick={() => setTagMode('all')}>ALL of</button>
                <button className={tagMode === 'any' ? 'active' : ''} onClick={() => setTagMode('any')}>ANY of</button>
              </div>
              <span className="muted" style={{ fontSize: 12 }}>
                {selectedTags.length === 0
                  ? 'No tags selected — all active subscribers included'
                  : `${selectedTags.length} tag${selectedTags.length === 1 ? '' : 's'} selected`}
              </span>
            </div>
            <TagFilter selected={selectedTags} onChange={setSelectedTags} />

            <div style={{ height: 1, background: 'var(--rule-soft)', margin: '20px 0' }} />

            <div className="label">Exclude subscribers with</div>
            <TagFilter selected={excludeTags} onChange={setExcludeTags} />
            {excludeTags.length === 0 && (
              <div className="muted" style={{ fontSize: 12, marginTop: 8, fontStyle: 'italic' }}>
                No exclusions
              </div>
            )}

            <div style={{
              marginTop: 22, padding: '16px 18px', borderRadius: 8,
              background: 'var(--paper-deep)', border: '1px solid var(--rule-soft)',
            }}>
              <div className="row items-center justify-between mb-md">
                <div>
                  <div className="serif" style={{ fontSize: 17 }}>
                    {fmt(recipientCount)} of {fmt(active.length)} active subscribers will receive this
                  </div>
                  <div className="muted" style={{ fontSize: 12, marginTop: 3 }}>
                    {pct(recipientCount, active.length)} of the active list
                  </div>
                </div>
              </div>
              {topTags.length > 0 && (
                <>
                  <div className="eyebrow" style={{ marginBottom: 8 }}>Tag breakdown</div>
                  <div className="row items-center" style={{ gap: 6, flexWrap: 'wrap' }}>
                    {topTags.map(([tag, n]) => (
                      <div key={tag} className="row items-center gap-sm" style={{
                        padding: '3px 9px 3px 3px',
                        background: 'var(--paper)', border: '1px solid var(--rule)',
                        borderRadius: 99, fontSize: 11.5,
                      }}>
                        <TagPill tagId={tag} size="sm" />
                        <span className="mono-sm" style={{ fontWeight: 500 }}>{fmt(n)}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
              {recipientCount > 0 && (
                <details style={{ marginTop: 14 }}>
                  <summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--accent-deep)', fontFamily: 'var(--sans)' }}>
                    Preview first 8 recipients
                  </summary>
                  <div style={{ marginTop: 10, display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '6px 14px' }}>
                    {recipients.slice(0, 8).map(r => (
                      <div key={r.id} className="row items-center gap-sm" style={{ fontSize: 12 }}>
                        <Avatar name={r.name} size={18} />
                        <span>{r.name}</span>
                        <span className="muted mono-sm" style={{ fontSize: 10 }}>{r.org}</span>
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </div>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="card">
          <div className="card-header">
            <div>
              <div className="eyebrow">Step 2</div>
              <h3 className="serif mt-sm">When should it go out?</h3>
            </div>
          </div>
          <div className="card-body">
            <div className="stack" style={{ gap: 10 }}>
              <label style={{
                display: 'flex', alignItems: 'flex-start', gap: 14,
                padding: 16, borderRadius: 8,
                border: `1px solid ${when === 'now' ? 'var(--accent)' : 'var(--rule)'}`,
                background: when === 'now' ? 'oklch(from var(--accent) l c h / 0.04)' : 'var(--paper)',
                cursor: 'pointer',
              }}>
                <input type="radio" name="when" checked={when === 'now'} onChange={() => setWhen('now')} style={{ marginTop: 3 }} />
                <div style={{ flex: 1 }}>
                  <div className="serif" style={{ fontSize: 15 }}>Send immediately</div>
                  <div className="muted mt-sm" style={{ fontSize: 12 }}>
                    Delivery begins as soon as you confirm — typically completes within 3–5 minutes.
                  </div>
                </div>
              </label>

              <label style={{
                display: 'flex', alignItems: 'flex-start', gap: 14,
                padding: 16, borderRadius: 8,
                border: `1px solid ${when === 'schedule' ? 'var(--accent)' : 'var(--rule)'}`,
                background: when === 'schedule' ? 'oklch(from var(--accent) l c h / 0.04)' : 'var(--paper)',
                cursor: 'pointer',
              }}>
                <input type="radio" name="when" checked={when === 'schedule'} onChange={() => setWhen('schedule')} style={{ marginTop: 3 }} />
                <div style={{ flex: 1 }}>
                  <div className="serif" style={{ fontSize: 15 }}>Schedule for later</div>
                  <div className="muted mt-sm" style={{ fontSize: 12 }}>
                    Pick a date and time — we'll hold the send in the queue and deliver on schedule.
                  </div>
                  {when === 'schedule' && (
                    <div className="row gap-md mt-md" onClick={e => e.stopPropagation()}>
                      <div style={{ flex: 1 }}>
                        <div className="label">Date</div>
                        <input type="date" className="input" value={scheduleDate} onChange={e => setScheduleDate(e.target.value)} />
                      </div>
                      <div style={{ flex: 1 }}>
                        <div className="label">Time (ET)</div>
                        <input type="time" className="input" value={scheduleTime} onChange={e => setScheduleTime(e.target.value)} />
                      </div>
                      <div style={{ flex: 1 }}>
                        <div className="label">Timezone</div>
                        <select className="select">
                          <option>America/New_York (ET)</option>
                          <option>America/Los_Angeles</option>
                          <option>UTC</option>
                        </select>
                      </div>
                    </div>
                  )}
                </div>
              </label>
            </div>

            {when === 'schedule' && (
              <div style={{
                marginTop: 16, padding: 14, borderRadius: 8,
                background: 'var(--paper-deep)', border: '1px solid var(--rule-soft)',
              }}>
                <div className="row items-center gap-sm">
                  <Icon name="calendar" size={14} />
                  <span className="serif" style={{ fontSize: 14 }}>
                    Will send on <strong>{fmtDate(scheduleDate)}</strong> at <strong>{scheduleTime} ET</strong>
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="card">
          <div className="card-header">
            <div>
              <div className="eyebrow">Step 3</div>
              <h3 className="serif mt-sm">Final review</h3>
            </div>
          </div>
          <div className="card-body">
            <dl style={{ display: 'grid', gridTemplateColumns: '140px 1fr', gap: '14px 20px', margin: 0 }}>
              <dt className="label" style={{ margin: 0 }}>Newsletter</dt>
              <dd style={{ margin: 0 }} className="serif">{draft?.title}</dd>
              <dt className="label" style={{ margin: 0 }}>Subject</dt>
              <dd style={{ margin: 0 }} className="serif">{draft?.subject || <span className="muted">(untitled)</span>}</dd>
              <dt className="label" style={{ margin: 0 }}>From</dt>
              <dd style={{ margin: 0 }} className="mono-sm">NDA Dispatch &lt;dispatch@nda.nih.gov&gt;</dd>
              <dt className="label" style={{ margin: 0 }}>Recipients</dt>
              <dd style={{ margin: 0 }}>
                <div>{fmt(recipientCount)} subscribers</div>
                {selectedTags.length > 0 && (
                  <div className="row items-center" style={{ gap: 5, flexWrap: 'wrap', marginTop: 6 }}>
                    <span className="muted" style={{ fontSize: 11.5 }}>{tagMode === 'all' ? 'with all of' : 'with any of'}</span>
                    {selectedTags.map(t => <TagPill key={t} tagId={t} size="sm" />)}
                  </div>
                )}
                {excludeTags.length > 0 && (
                  <div className="row items-center" style={{ gap: 5, flexWrap: 'wrap', marginTop: 4 }}>
                    <span className="muted" style={{ fontSize: 11.5 }}>excluding</span>
                    {excludeTags.map(t => <TagPill key={t} tagId={t} size="sm" />)}
                  </div>
                )}
              </dd>
              <dt className="label" style={{ margin: 0 }}>Timing</dt>
              <dd style={{ margin: 0 }}>
                {when === 'now'
                  ? <><Icon name="send" size={12} /> Send immediately</>
                  : <><Icon name="calendar" size={12} /> {fmtDate(scheduleDate)} at {scheduleTime} ET</>}
              </dd>
              <dt className="label" style={{ margin: 0 }}>Content</dt>
              <dd style={{ margin: 0 }}>
                <span className="mono-sm">{(draft?.html || '').length.toLocaleString()} characters</span> · <a className="link-ghost" onClick={onBack}>Edit</a>
              </dd>
            </dl>

            <div style={{
              marginTop: 20, padding: 14, borderRadius: 8,
              background: 'oklch(0.96 0.02 75)', border: '1px solid oklch(0.88 0.05 75)',
              display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: 13,
            }}>
              <Icon name="alert" size={14} />
              <div>
                Once sent, a newsletter cannot be recalled. Double-check your subject line, recipient tags, and content before confirming.
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="row justify-between">
        <button className="btn" onClick={() => step === 1 ? onBack() : setStep(step - 1)}>
          <Icon name="arrowleft" size={12} /> {step === 1 ? 'Back to editor' : 'Previous'}
        </button>
        {step < 3 ? (
          <button className="btn btn-primary" onClick={() => setStep(step + 1)} disabled={recipientCount === 0}>
            Continue <Icon name="arrowright" size={12} />
          </button>
        ) : (
          <button className="btn btn-accent" onClick={() => onSent({
            when, scheduleDate, scheduleTime,
            count: recipientCount,
            tags: selectedTags, tagMode, excludeTags,
            draftId: draft?.id, title: draft?.title, subject: draft?.subject,
          })}>
            <Icon name="send" size={13} />
            {when === 'now' ? `Send to ${fmt(recipientCount)} subscribers` : 'Schedule send'}
          </button>
        )}
      </div>
    </div>
  );
};

const SentModal = ({ info, onClose }) => {
  const isScheduled = info.when === 'schedule';
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header" style={{ textAlign: 'center', paddingTop: 36 }}>
          <div style={{
            width: 54, height: 54, borderRadius: '50%',
            background: isScheduled ? 'oklch(0.95 0.04 75)' : 'oklch(0.95 0.04 145)',
            color: isScheduled ? 'oklch(0.42 0.11 75)' : 'oklch(0.42 0.10 145)',
            margin: '0 auto 18px', display: 'grid', placeItems: 'center',
          }}>
            <Icon name={isScheduled ? 'calendar' : 'checkcircle'} size={26} stroke={1.75} />
          </div>
          <h2 className="serif" style={{ fontSize: 24 }}>
            {isScheduled ? 'Scheduled' : 'On its way'}
          </h2>
          <p className="muted" style={{ fontSize: 14, marginTop: 8 }}>
            {isScheduled
              ? <>Your newsletter will be delivered on <strong>{fmtDate(info.scheduleDate)}</strong> at <strong>{info.scheduleTime} ET</strong>.</>
              : <>Delivery to <strong>{fmt(info.count)}</strong> subscribers has begun. You'll see it in History once complete.</>}
          </p>
        </div>
        <div className="modal-footer" style={{ justifyContent: 'center', padding: '18px 28px 22px' }}>
          <button className="btn btn-primary" onClick={onClose}>View in History</button>
        </div>
      </div>
    </div>
  );
};

Object.assign(window, { SendView, SentModal });
