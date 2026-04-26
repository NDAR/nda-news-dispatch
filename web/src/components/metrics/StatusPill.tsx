import type { CampaignStatus } from '../../api/endpoints';

const LABEL: Record<CampaignStatus, string> = {
  scheduled: 'Scheduled',
  queued: 'Sent',
  sending: 'Sending',
  sent: 'Sent',
  draft: 'Draft',
  failed: 'Failed',
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
};

export function StatusPill({ status }: { status: CampaignStatus }) {
  return (
    <span className={`pill ${PILL_CLASS[status]}`}>
      <span className="pill-dot" />
      {LABEL[status]}
    </span>
  );
}
