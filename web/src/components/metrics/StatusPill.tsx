import type { CampaignStatus } from '../../api/endpoints';

const LABEL: Record<CampaignStatus, string> = {
  scheduled: 'Scheduled',
  queued: 'Sent',
  sending: 'Sending',
  sent: 'Sent',
  draft: 'Draft',
  failed: 'Failed',
  simulated: 'Dry-run',
};

// Map storage status → CSS class. queued/sent/sending all read as "Sent" to
// users; collapse them onto the same green pill.
const PILL_CLASS: Record<CampaignStatus, string> = {
  scheduled: 'scheduled',
  queued: 'queued',
  sending: 'queued',
  sent: 'sent',
  draft: 'draft',
  failed: 'failed',
  // Reuse the neutral draft styling — clearly not-a-real-send.
  simulated: 'draft',
};

export function StatusPill({ status }: { status: CampaignStatus }) {
  return (
    <span className={`pill ${PILL_CLASS[status]}`}>
      <span className="pill-dot" />
      {LABEL[status]}
    </span>
  );
}
