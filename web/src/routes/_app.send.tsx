import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import {
  createCampaign,
  listTags,
  listTemplates,
  previewAudience,
  sendCampaign,
  type AudiencePreview,
  type Template,
} from '../api/endpoints';

export const Route = createFileRoute('/_app/send')({
  component: SendPage,
});

type Step = 1 | 2 | 3;
type TagMode = 'all' | 'any';
type WhenMode = 'now' | 'schedule';

interface SentInfo {
  campaignId: string;
  enqueued: number;
  when: WhenMode;
  scheduleDate?: string;
  scheduleTime?: string;
}

function SendPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();

  const { data: templates = [] } = useQuery({
    queryKey: ['templates'],
    queryFn: listTemplates,
  });
  const { data: tagsResp, isLoading: tagsLoading } = useQuery({
    queryKey: ['admin-tags'],
    queryFn: listTags,
  });
  const knownTags = useMemo(
    () => (tagsResp?.items ?? []).map((t) => t.tag),
    [tagsResp],
  );

  const [templateId, setTemplateId] = useState<string>('');
  const [campaignName, setCampaignName] = useState('');
  const [step, setStep] = useState<Step>(1);

  // Step 1
  const [tagMode, setTagMode] = useState<TagMode>('all');
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [excludeTags, setExcludeTags] = useState<string[]>([]);

  // Step 2
  const [when, setWhen] = useState<WhenMode>('now');
  const [scheduleDate, setScheduleDate] = useState(todayISO(60));
  const [scheduleTime, setScheduleTime] = useState(roundedFutureTime(60));
  const [scheduleTz, setScheduleTz] = useState<string>(
    Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York',
  );

  const [sent, setSent] = useState<SentInfo | null>(null);

  const template = useMemo(
    () => templates.find((t) => t.id === templateId),
    [templates, templateId],
  );

  // Live audience preview — re-runs whenever the filter changes. Debounced
  // 350ms so dragging through tag chips doesn't flood the API.
  const debouncedFilter = useDebouncedValue(
    { tags: selectedTags, excludeTags, tagMode },
    350,
  );
  const { data: audience, isFetching: previewLoading } = useQuery<AudiencePreview>({
    queryKey: ['audience-preview', debouncedFilter],
    queryFn: () => previewAudience(debouncedFilter),
    placeholderData: (prev) => prev,
  });
  const recipientCount = audience?.count ?? 0;
  const total = audience?.total ?? 0;
  const topTags = useMemo<[string, number][]>(
    () => (audience?.topTags ?? []).map((t) => [t.tag, t.count]),
    [audience],
  );
  const sample = audience?.sample ?? [];

  const sendMut = useMutation({
    mutationFn: async () => {
      if (!template) throw new Error('Pick a template');
      const scheduleAt =
        when === 'schedule' ? scheduleAtISO(scheduleDate, scheduleTime, scheduleTz) : undefined;
      const c = await createCampaign({
        templateId: template.id,
        name: campaignName || template.title,
      });
      const r = await sendCampaign(c.id, {
        tagMode,
        tags: selectedTags,
        excludeTags,
        scheduleAt,
      });
      return { campaignId: c.id, enqueued: r.enqueued };
    },
    onSuccess: (r) => {
      setSent({
        campaignId: r.campaignId,
        enqueued: r.enqueued,
        when,
        scheduleDate: when === 'schedule' ? scheduleDate : undefined,
        scheduleTime: when === 'schedule' ? scheduleTime : undefined,
      });
      qc.invalidateQueries({ queryKey: ['campaigns'] });
    },
  });

  // ── Render ────────────────────────────────────────────────────────────────

  if (templates.length === 0) {
    return (
      <div className="muted" style={{ padding: 40, textAlign: 'center' }}>
        No newsletters yet — <Link to="/compose">go compose one</Link> first.
      </div>
    );
  }

  if (!templateId) {
    return (
      <div className="card" style={{ maxWidth: 640 }}>
        <div className="card-header">
          <div>
            <div className="eyebrow">Delivery</div>
            <h3 className="serif mt-sm">Pick a newsletter to send</h3>
          </div>
        </div>
        <div className="card-body stack" style={{ gap: 14 }}>
          <div>
            <div className="label">Newsletter</div>
            <select
              className="select"
              value={templateId}
              onChange={(e) => {
                setTemplateId(e.target.value);
                const t = templates.find((x) => x.id === e.target.value);
                if (t) setCampaignName(t.title);
              }}
            >
              <option value="">— choose —</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title} (v{t.version})
                </option>
              ))}
            </select>
          </div>
          <div>
            <div className="label">Campaign name (internal)</div>
            <input
              className="input"
              value={campaignName}
              onChange={(e) => setCampaignName(e.target.value)}
              placeholder="Auto-fills from newsletter title"
            />
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="stack" style={{ gap: 24, maxWidth: 860 }}>
        <HeaderBanner
          template={template}
          onChangeTemplate={() => {
            setTemplateId('');
            setStep(1);
          }}
          onEditContent={() => navigate({ to: '/compose' })}
        />

        <Stepper step={step} />

        {step === 1 && (
          <RecipientsStep
            tagMode={tagMode}
            setTagMode={setTagMode}
            selectedTags={selectedTags}
            setSelectedTags={setSelectedTags}
            excludeTags={excludeTags}
            setExcludeTags={setExcludeTags}
            knownTags={knownTags}
            sample={sample}
            recipientCount={recipientCount}
            activeTotal={total}
            topTags={topTags}
            tagsLoading={tagsLoading}
            previewLoading={previewLoading}
          />
        )}

        {step === 2 && (
          <TimingStep
            when={when}
            setWhen={setWhen}
            scheduleDate={scheduleDate}
            scheduleTime={scheduleTime}
            scheduleTz={scheduleTz}
            setScheduleDate={setScheduleDate}
            setScheduleTime={setScheduleTime}
            setScheduleTz={setScheduleTz}
          />
        )}

        {step === 3 && (
          <ReviewStep
            template={template}
            campaignName={campaignName}
            recipientCount={recipientCount}
            selectedTags={selectedTags}
            excludeTags={excludeTags}
            tagMode={tagMode}
            when={when}
            scheduleDate={scheduleDate}
            scheduleTime={scheduleTime}
            scheduleTz={scheduleTz}
          />
        )}

        {sendMut.error && (
          <div style={{ color: 'var(--bad)', fontSize: 13 }}>
            {(sendMut.error as Error).message}
          </div>
        )}

        <div className="row justify-between">
          <button
            className="btn"
            onClick={() => (step === 1 ? setTemplateId('') : setStep((step - 1) as Step))}
            disabled={sendMut.isPending}
          >
            ← {step === 1 ? 'Change newsletter' : 'Previous'}
          </button>
          {step < 3 ? (
            <ContinueButton
              step={step}
              recipientCount={recipientCount}
              when={when}
              scheduleAt={
                when === 'schedule'
                  ? scheduleAtISO(scheduleDate, scheduleTime, scheduleTz)
                  : ''
              }
              onClick={() => setStep((step + 1) as Step)}
            />
          ) : (
            <button
              className="btn btn-accent"
              onClick={() => sendMut.mutate()}
              disabled={
                sendMut.isPending ||
                recipientCount === 0 ||
                (when === 'schedule' && !isValidScheduleTime(scheduleDate, scheduleTime, scheduleTz))
              }
            >
              {sendMut.isPending
                ? when === 'now' ? 'Sending…' : 'Scheduling…'
                : when === 'now'
                  ? `Send to ${fmt(recipientCount)} subscriber${recipientCount === 1 ? '' : 's'}`
                  : 'Schedule send'}
            </button>
          )}
        </div>
      </div>

      {sent && (
        <SentModal
          info={sent}
          onClose={() => navigate({ to: '/history' })}
        />
      )}
    </>
  );
}

// ── Header banner ───────────────────────────────────────────────────────────

function HeaderBanner({
  template,
  onChangeTemplate,
  onEditContent,
}: {
  template: Template | undefined;
  onChangeTemplate: () => void;
  onEditContent: () => void;
}) {
  return (
    <div className="card" style={{ background: 'var(--paper-deep)' }}>
      <div className="card-body" style={{ padding: '14px 18px' }}>
        <div className="row items-center gap-md">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="eyebrow">Sending</div>
            <div className="serif" style={{ fontSize: 17, marginTop: 2 }}>
              {template?.title || 'Untitled'}
            </div>
            <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>
              <strong style={{ color: 'var(--ink-soft)', fontWeight: 500 }}>Subject:</strong>{' '}
              {template?.subject || <em className="faint">(no subject yet)</em>}
            </div>
          </div>
          <button className="btn btn-sm" onClick={onChangeTemplate}>
            Change
          </button>
          <button className="btn btn-sm" onClick={onEditContent}>
            Edit content
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Stepper ─────────────────────────────────────────────────────────────────

function Stepper({ step }: { step: Step }) {
  const labels: [number, string][] = [[1, 'Recipients'], [2, 'Timing'], [3, 'Review & send']];
  return (
    <div className="row items-center gap-md" style={{ padding: '6px 0' }}>
      {labels.map(([idx, label], i) => {
        const active = step === idx;
        const done = step > idx;
        return (
          <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 16, flex: i === labels.length - 1 ? '0 0 auto' : 1 }}>
            <div className="row items-center gap-sm" style={{ opacity: active || done ? 1 : 0.5 }}>
              <div
                style={{
                  width: 26,
                  height: 26,
                  borderRadius: '50%',
                  background: done ? 'var(--good)' : active ? 'var(--ink)' : 'var(--paper-deep)',
                  color: done || active ? 'var(--paper)' : 'var(--ink-mute)',
                  display: 'grid',
                  placeItems: 'center',
                  fontFamily: 'var(--serif)',
                  fontSize: 13,
                  fontWeight: 500,
                  border: done || active ? 'none' : '1px solid var(--rule)',
                }}
              >
                {done ? '✓' : idx}
              </div>
              <span className="serif" style={{ fontSize: 15 }}>
                {label}
              </span>
            </div>
            {i < labels.length - 1 && <div style={{ flex: 1, height: 1, background: 'var(--rule)' }} />}
          </div>
        );
      })}
    </div>
  );
}

// ── Step 1 ──────────────────────────────────────────────────────────────────

function RecipientsStep(props: {
  tagMode: TagMode;
  setTagMode: (m: TagMode) => void;
  selectedTags: string[];
  setSelectedTags: (t: string[]) => void;
  excludeTags: string[];
  setExcludeTags: (t: string[]) => void;
  knownTags: string[];
  sample: { email: string; name: string; org?: string }[];
  recipientCount: number;
  activeTotal: number;
  topTags: [string, number][];
  tagsLoading: boolean;
  previewLoading: boolean;
}) {
  const {
    tagMode, setTagMode,
    selectedTags, setSelectedTags,
    excludeTags, setExcludeTags,
    knownTags, sample, recipientCount, activeTotal, topTags,
    tagsLoading, previewLoading,
  } = props;

  return (
    <div className="card">
      <div className="card-header">
        <div>
          <div className="eyebrow">Step 1</div>
          <h3 className="serif mt-sm">Filter by tag</h3>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div className="serif" style={{ fontSize: 26, lineHeight: 1, opacity: previewLoading ? 0.5 : 1 }}>
            {fmt(recipientCount)}
          </div>
          <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
            {previewLoading ? 'recalculating…' : `recipient${recipientCount === 1 ? '' : 's'}`}
          </div>
        </div>
      </div>
      <div className="card-body">
        <div className="label">Include subscribers with</div>
        <div className="row items-center gap-sm" style={{ marginBottom: 10 }}>
          <div className="segmented">
            <button className={tagMode === 'all' ? 'active' : ''} onClick={() => setTagMode('all')}>
              ALL of
            </button>
            <button className={tagMode === 'any' ? 'active' : ''} onClick={() => setTagMode('any')}>
              ANY of
            </button>
          </div>
          <span className="muted" style={{ fontSize: 12 }}>
            {selectedTags.length === 0
              ? 'No tags selected — all active subscribers included'
              : `${selectedTags.length} tag${selectedTags.length === 1 ? '' : 's'} selected`}
          </span>
        </div>
        <TagFilter knownTags={knownTags} selected={selectedTags} onChange={setSelectedTags} loading={tagsLoading} />

        <div style={{ height: 1, background: 'var(--rule-soft)', margin: '20px 0' }} />

        <div className="label">Exclude subscribers with</div>
        <TagFilter knownTags={knownTags} selected={excludeTags} onChange={setExcludeTags} loading={tagsLoading} />
        {excludeTags.length === 0 && (
          <div className="muted" style={{ fontSize: 12, marginTop: 8, fontStyle: 'italic' }}>
            No exclusions
          </div>
        )}

        <div
          style={{
            marginTop: 22,
            padding: '16px 18px',
            borderRadius: 8,
            background: 'var(--paper-deep)',
            border: '1px solid var(--rule-soft)',
          }}
        >
          <div className="row items-center justify-between" style={{ marginBottom: 12 }}>
            <div>
              <div className="serif" style={{ fontSize: 17 }}>
                {fmt(recipientCount)} of {fmt(activeTotal)} active subscribers will receive this
              </div>
              <div className="muted" style={{ fontSize: 12, marginTop: 3 }}>
                {pct(recipientCount, activeTotal)} of the active list
              </div>
            </div>
          </div>
          {topTags.length > 0 && (
            <>
              <div className="eyebrow" style={{ marginBottom: 8 }}>
                Tag breakdown
              </div>
              <div className="row items-center" style={{ gap: 6, flexWrap: 'wrap' }}>
                {topTags.map(([tag, n]) => (
                  <div
                    key={tag}
                    className="row items-center gap-sm"
                    style={{
                      padding: '3px 9px 3px 9px',
                      background: 'var(--paper)',
                      border: '1px solid var(--rule)',
                      borderRadius: 99,
                      fontSize: 11.5,
                    }}
                  >
                    <TagPill tag={tag} />
                    <span className="mono-sm" style={{ fontWeight: 500 }}>
                      {fmt(n)}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
          {sample.length > 0 && (
            <details style={{ marginTop: 14 }}>
              <summary
                style={{
                  cursor: 'pointer',
                  fontSize: 12,
                  color: 'var(--accent-deep)',
                  fontFamily: 'var(--sans)',
                }}
              >
                Preview first {sample.length} recipient{sample.length === 1 ? '' : 's'}
              </summary>
              <div
                style={{
                  marginTop: 10,
                  display: 'grid',
                  gridTemplateColumns: 'repeat(2, 1fr)',
                  gap: '6px 14px',
                }}
              >
                {sample.map((r) => (
                  <div key={r.email} className="row items-center gap-sm" style={{ fontSize: 12 }}>
                    <Avatar name={r.name || r.email} />
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {r.name || r.email}
                    </span>
                    {r.org && (
                      <span className="muted mono-sm" style={{ fontSize: 10 }}>
                        {r.org}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Step 2 ──────────────────────────────────────────────────────────────────

function TimingStep({
  when,
  setWhen,
  scheduleDate,
  scheduleTime,
  scheduleTz,
  setScheduleDate,
  setScheduleTime,
  setScheduleTz,
}: {
  when: WhenMode;
  setWhen: (w: WhenMode) => void;
  scheduleDate: string;
  scheduleTime: string;
  scheduleTz: string;
  setScheduleDate: (s: string) => void;
  setScheduleTime: (s: string) => void;
  setScheduleTz: (s: string) => void;
}) {
  // We assemble the full ISO timestamp here just to compute the "Will send
  // on …" preview line and to validate that the user picked a time at least
  // a minute in the future.
  const scheduledIso = scheduleAtISO(scheduleDate, scheduleTime, scheduleTz);
  const scheduledDate = scheduledIso ? new Date(scheduledIso) : null;
  const tooSoon =
    when === 'schedule' && scheduledDate
      ? scheduledDate.getTime() < Date.now() + 60_000
      : false;

  return (
    <div className="card">
      <div className="card-header">
        <div>
          <div className="eyebrow">Step 2</div>
          <h3 className="serif mt-sm">When should it go out?</h3>
        </div>
      </div>
      <div className="card-body">
        <div className="stack" style={{ gap: 10 }}>
          <label
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 14,
              padding: 16,
              borderRadius: 8,
              border: `1px solid ${when === 'now' ? 'var(--accent)' : 'var(--rule)'}`,
              background: when === 'now' ? 'oklch(from var(--accent) l c h / 0.04)' : 'var(--paper)',
              cursor: 'pointer',
            }}
          >
            <input
              type="radio"
              name="when"
              checked={when === 'now'}
              onChange={() => setWhen('now')}
              style={{ marginTop: 3 }}
            />
            <div style={{ flex: 1 }}>
              <div className="serif" style={{ fontSize: 15 }}>
                Send immediately
              </div>
              <div className="muted mt-sm" style={{ fontSize: 12 }}>
                Delivery begins as soon as you confirm — typically completes within 3–5 minutes.
              </div>
            </div>
          </label>

          <label
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 14,
              padding: 16,
              borderRadius: 8,
              border: `1px solid ${when === 'schedule' ? 'var(--accent)' : 'var(--rule)'}`,
              background:
                when === 'schedule' ? 'oklch(from var(--accent) l c h / 0.04)' : 'var(--paper)',
              cursor: 'pointer',
            }}
          >
            <input
              type="radio"
              name="when"
              checked={when === 'schedule'}
              onChange={() => setWhen('schedule')}
              style={{ marginTop: 3 }}
            />
            <div style={{ flex: 1 }}>
              <div className="serif" style={{ fontSize: 15 }}>
                Schedule for later
              </div>
              <div className="muted mt-sm" style={{ fontSize: 12 }}>
                Pick a date and time — we'll hold the send and deliver on schedule (must be at
                least 1 minute in the future).
              </div>
              {when === 'schedule' && (
                <div
                  className="row gap-md mt-md"
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => e.stopPropagation()}
                >
                  <div style={{ flex: 1 }}>
                    <div className="label">Date</div>
                    <input
                      type="date"
                      className="input"
                      value={scheduleDate}
                      min={todayISO()}
                      onChange={(e) => setScheduleDate(e.target.value)}
                    />
                  </div>
                  <div style={{ flex: 1 }}>
                    <div className="label">Time</div>
                    <input
                      type="time"
                      className="input"
                      value={scheduleTime}
                      onChange={(e) => setScheduleTime(e.target.value)}
                    />
                  </div>
                  <div style={{ flex: 1 }}>
                    <div className="label">Timezone</div>
                    <select
                      className="select"
                      value={scheduleTz}
                      onChange={(e) => setScheduleTz(e.target.value)}
                    >
                      {TIMEZONES.map((tz) => (
                        <option key={tz} value={tz}>{tz}</option>
                      ))}
                    </select>
                  </div>
                </div>
              )}
            </div>
          </label>
        </div>

        {when === 'schedule' && (
          <div
            style={{
              marginTop: 16,
              padding: 14,
              borderRadius: 8,
              background: tooSoon ? 'oklch(0.96 0.04 25)' : 'var(--paper-deep)',
              border: `1px solid ${tooSoon ? 'oklch(0.85 0.06 25)' : 'var(--rule-soft)'}`,
              fontSize: 13,
            }}
          >
            {tooSoon ? (
              <span style={{ color: 'var(--bad)' }}>
                ⚠ Scheduled time must be at least 1 minute in the future.
              </span>
            ) : scheduledDate ? (
              <span className="serif">
                📅 Will send on{' '}
                <strong>
                  {scheduledDate.toLocaleString(undefined, {
                    weekday: 'long',
                    month: 'long',
                    day: 'numeric',
                    hour: 'numeric',
                    minute: '2-digit',
                    timeZoneName: 'short',
                  })}
                </strong>
              </span>
            ) : (
              <span className="muted">Pick a date and time above.</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Step 3 ──────────────────────────────────────────────────────────────────

function ReviewStep({
  template,
  campaignName,
  recipientCount,
  selectedTags,
  excludeTags,
  tagMode,
  when,
  scheduleDate,
  scheduleTime,
  scheduleTz,
}: {
  template: Template | undefined;
  campaignName: string;
  recipientCount: number;
  selectedTags: string[];
  excludeTags: string[];
  tagMode: TagMode;
  when: WhenMode;
  scheduleDate: string;
  scheduleTime: string;
  scheduleTz: string;
}) {
  const scheduledIso = when === 'schedule' ? scheduleAtISO(scheduleDate, scheduleTime, scheduleTz) : '';
  const scheduledDate = scheduledIso ? new Date(scheduledIso) : null;
  return (
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
          <dd style={{ margin: 0 }} className="serif">{template?.title}</dd>

          <dt className="label" style={{ margin: 0 }}>Campaign name</dt>
          <dd style={{ margin: 0 }} className="serif">{campaignName || template?.title}</dd>

          <dt className="label" style={{ margin: 0 }}>Subject</dt>
          <dd style={{ margin: 0 }} className="serif">
            {template?.subject || <span className="muted">(untitled)</span>}
          </dd>

          <dt className="label" style={{ margin: 0 }}>Recipients</dt>
          <dd style={{ margin: 0 }}>
            <div>{fmt(recipientCount)} subscriber{recipientCount === 1 ? '' : 's'}</div>
            {selectedTags.length > 0 && (
              <div className="row items-center" style={{ gap: 5, flexWrap: 'wrap', marginTop: 6 }}>
                <span className="muted" style={{ fontSize: 11.5 }}>
                  {tagMode === 'all' ? 'with all of' : 'with any of'}
                </span>
                {selectedTags.map((t) => <TagPill key={t} tag={t} />)}
              </div>
            )}
            {excludeTags.length > 0 && (
              <div className="row items-center" style={{ gap: 5, flexWrap: 'wrap', marginTop: 4 }}>
                <span className="muted" style={{ fontSize: 11.5 }}>excluding</span>
                {excludeTags.map((t) => <TagPill key={t} tag={t} />)}
              </div>
            )}
          </dd>

          <dt className="label" style={{ margin: 0 }}>Timing</dt>
          <dd style={{ margin: 0 }}>
            {when === 'now' ? (
              '→ Send immediately'
            ) : scheduledDate ? (
              <>
                📅{' '}
                {scheduledDate.toLocaleString(undefined, {
                  weekday: 'long',
                  month: 'long',
                  day: 'numeric',
                  hour: 'numeric',
                  minute: '2-digit',
                  timeZoneName: 'short',
                })}{' '}
                <span className="muted mono-sm" style={{ fontSize: 11 }}>({scheduleTz})</span>
              </>
            ) : (
              <span className="muted">(invalid time)</span>
            )}
          </dd>

          <dt className="label" style={{ margin: 0 }}>Content</dt>
          <dd style={{ margin: 0 }}>
            <span className="mono-sm">
              {(template?.html?.length ?? 0).toLocaleString()} characters
            </span>
            {' · '}
            <Link to="/compose" className="link-ghost">Edit</Link>
          </dd>
        </dl>

        <div
          style={{
            marginTop: 20,
            padding: 14,
            borderRadius: 8,
            background: 'oklch(0.96 0.02 75)',
            border: '1px solid oklch(0.88 0.05 75)',
            display: 'flex',
            gap: 10,
            alignItems: 'flex-start',
            fontSize: 13,
          }}
        >
          <span style={{ fontSize: 16, lineHeight: 1 }}>⚠</span>
          <div>
            Once sent, a newsletter cannot be recalled. Double-check your subject line, recipient
            tags, and content before confirming.
          </div>
        </div>
      </div>
    </div>
  );
}

// ── TagFilter (visual chip multi-select) ───────────────────────────────────

function TagFilter({
  knownTags,
  selected,
  onChange,
  loading,
}: {
  knownTags: string[];
  selected: string[];
  onChange: (t: string[]) => void;
  loading: boolean;
}) {
  const [draft, setDraft] = useState('');

  const toggle = (tag: string) => {
    onChange(selected.includes(tag) ? selected.filter((t) => t !== tag) : [...selected, tag]);
  };
  const addCustom = () => {
    const t = draft.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    if (!t) return;
    if (!selected.includes(t)) onChange([...selected, t]);
    setDraft('');
  };

  const unselected = knownTags.filter((t) => !selected.includes(t));

  return (
    <div className="stack" style={{ gap: 8 }}>
      {selected.length > 0 && (
        <div className="row items-center" style={{ gap: 6, flexWrap: 'wrap' }}>
          {selected.map((t) => (
            <button
              key={t}
              onClick={() => toggle(t)}
              title="Click to remove"
              style={{
                background: 'var(--ink)',
                color: 'var(--paper)',
                border: 'none',
                borderRadius: 99,
                padding: '4px 10px',
                fontSize: 11.5,
                fontFamily: 'var(--sans)',
                cursor: 'pointer',
              }}
            >
              {t} ×
            </button>
          ))}
        </div>
      )}
      <div className="row items-center" style={{ gap: 6, flexWrap: 'wrap' }}>
        {loading && <span className="muted" style={{ fontSize: 12 }}>Loading tags…</span>}
        {!loading && unselected.length === 0 && selected.length === 0 && (
          <span className="muted" style={{ fontSize: 12 }}>
            No tags found in your subscriber list — use the input to add one.
          </span>
        )}
        {unselected.map((t) => (
          <button
            key={t}
            onClick={() => toggle(t)}
            style={{
              background: 'var(--paper)',
              color: 'var(--ink-soft)',
              border: '1px solid var(--rule)',
              borderRadius: 99,
              padding: '4px 10px',
              fontSize: 11.5,
              fontFamily: 'var(--sans)',
              cursor: 'pointer',
            }}
          >
            + {t}
          </button>
        ))}
      </div>
      <div className="row items-center gap-sm">
        <input
          className="input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              addCustom();
            }
          }}
          placeholder="Add custom tag…"
          style={{ flex: 1, fontSize: 12, padding: '6px 10px' }}
        />
        <button className="btn btn-sm" onClick={addCustom} disabled={!draft.trim()}>
          Add
        </button>
      </div>
    </div>
  );
}

// ── Sent confirmation modal ────────────────────────────────────────────────

function SentModal({ info, onClose }: { info: SentInfo; onClose: () => void }) {
  const isScheduled = info.when === 'schedule';
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header" style={{ textAlign: 'center', paddingTop: 36 }}>
          <div
            style={{
              width: 54,
              height: 54,
              borderRadius: '50%',
              background: isScheduled ? 'oklch(0.95 0.04 75)' : 'oklch(0.95 0.04 145)',
              color: isScheduled ? 'oklch(0.42 0.11 75)' : 'oklch(0.42 0.10 145)',
              margin: '0 auto 18px',
              display: 'grid',
              placeItems: 'center',
              fontSize: 26,
              fontFamily: 'var(--serif)',
            }}
          >
            {isScheduled ? '📅' : '✓'}
          </div>
          <h2 className="serif" style={{ fontSize: 24 }}>
            {isScheduled ? 'Scheduled' : 'On its way'}
          </h2>
          <p className="muted" style={{ fontSize: 14, marginTop: 8 }}>
            {isScheduled ? (
              <>
                Your newsletter will be delivered on <strong>{fmtDate(info.scheduleDate ?? '')}</strong>{' '}
                at <strong>{info.scheduleTime} ET</strong>.
              </>
            ) : (
              <>
                Delivery to <strong>{fmt(info.enqueued)}</strong> subscriber
                {info.enqueued === 1 ? '' : 's'} has begun. You'll see it in History once complete.
              </>
            )}
          </p>
        </div>
        <div
          className="modal-footer"
          style={{ justifyContent: 'center', padding: '18px 28px 22px' }}
        >
          <button className="btn btn-primary" onClick={onClose}>
            View in History
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Small bits ──────────────────────────────────────────────────────────────

function TagPill({ tag }: { tag: string }) {
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        background: 'var(--paper-deep)',
        border: '1px solid var(--rule)',
        borderRadius: 99,
        fontSize: 11,
        fontFamily: 'var(--sans)',
        color: 'var(--ink-soft)',
      }}
    >
      {tag}
    </span>
  );
}

function Avatar({ name }: { name: string }) {
  const initials = name
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]!.toUpperCase())
    .join('') || '?';
  return (
    <div
      className="avatar"
      style={{ width: 18, height: 18, fontSize: 9 }}
    >
      {initials}
    </div>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function useDebouncedValue<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [JSON.stringify(value), ms]); // eslint-disable-line react-hooks/exhaustive-deps
  return debounced;
}

function ContinueButton({
  step,
  recipientCount,
  when,
  scheduleAt,
  onClick,
}: {
  step: Step;
  recipientCount: number;
  when: WhenMode;
  scheduleAt: string;
  onClick: () => void;
}) {
  let disabled = false;
  let title: string | undefined;
  if (step === 1 && recipientCount === 0) {
    disabled = true;
    title = 'No subscribers match the current tag filter';
  } else if (step === 2 && when === 'schedule') {
    if (!scheduleAt) {
      disabled = true;
      title = 'Pick a valid date and time';
    } else if (Date.parse(scheduleAt) < Date.now() + 60_000) {
      disabled = true;
      title = 'Scheduled time must be at least 1 minute in the future';
    }
  }
  return (
    <button className="btn btn-primary" onClick={onClick} disabled={disabled} title={title}>
      Continue →
    </button>
  );
}

const TIMEZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Anchorage',
  'Pacific/Honolulu',
  'UTC',
  'Europe/London',
  'Europe/Berlin',
  'Asia/Tokyo',
];

/**
 * Combines a calendar date (YYYY-MM-DD), wall-clock time (HH:mm), and IANA
 * timezone into an ISO-8601 UTC string. Returns '' if the date or time
 * is malformed (lets the UI render a "(invalid time)" affordance instead
 * of throwing).
 */
function scheduleAtISO(date: string, time: string, tz: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return '';
  // Build a "naive" wall-clock Date in the user's tz. The trick: we ask
  // Intl.DateTimeFormat for the offset that the chosen tz applies on that
  // date, then subtract it from the naive UTC interpretation.
  const naive = new Date(`${date}T${time}:00Z`);
  if (Number.isNaN(naive.getTime())) return '';
  const offsetMs = tzOffsetAt(tz, naive);
  return new Date(naive.getTime() - offsetMs).toISOString();
}

function tzOffsetAt(tz: string, when: Date): number {
  // Format the same instant in UTC and in the target tz, parse both back to
  // numbers, and the difference is the tz's offset (in ms) at that instant.
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const parts = f.formatToParts(when).reduce<Record<string, string>>((acc, p) => {
    if (p.type !== 'literal') acc[p.type] = p.value;
    return acc;
  }, {});
  const asLocal = Date.UTC(
    +parts.year, +parts.month - 1, +parts.day,
    +parts.hour, +parts.minute, +parts.second,
  );
  return asLocal - when.getTime();
}

function isValidScheduleTime(date: string, time: string, tz: string): boolean {
  const iso = scheduleAtISO(date, time, tz);
  if (!iso) return false;
  return Date.parse(iso) >= Date.now() + 60_000;
}

function fmt(n: number): string {
  return n.toLocaleString();
}

function pct(a: number, b: number): string {
  if (!b) return '0%';
  return `${((a / b) * 100).toFixed(a === b ? 0 : 1)}%`;
}

function fmtDate(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
}

/** YYYY-MM-DD for today (or `minutesAhead` from now), in the browser's locale tz. */
function todayISO(minutesAhead = 0): string {
  const d = new Date(Date.now() + minutesAhead * 60_000);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** HH:mm string for `minutesAhead` from now, rounded up to the next 15-min slot. */
function roundedFutureTime(minutesAhead: number): string {
  const target = new Date(Date.now() + minutesAhead * 60_000);
  const m = target.getMinutes();
  const rounded = Math.ceil(m / 15) * 15;
  if (rounded >= 60) {
    target.setHours(target.getHours() + 1);
    target.setMinutes(0);
  } else {
    target.setMinutes(rounded);
  }
  return `${String(target.getHours()).padStart(2, '0')}:${String(target.getMinutes()).padStart(2, '0')}`;
}
