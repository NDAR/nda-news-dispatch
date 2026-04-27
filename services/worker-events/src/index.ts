import type { SNSHandler, SNSEventRecord } from 'aws-lambda';
import { createHash } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { applySuppression, contactStatusIndexFields, suppressionState } from '../../../packages/shared/src';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const TABLE = mustEnv('TABLE_NAME');

/**
 * SES Configuration-Set event publishing → SNS → this handler.
 *
 * Each SES event has this shape (condensed):
 *   { eventType: 'Send'|'Delivery'|'Bounce'|'Complaint'|'Open'|'Click'|
 *                'Reject'|'DeliveryDelay'|'RenderingFailure'|'Subscription',
 *     mail: { messageId, destination: [...], tags: { 'campaign-id': [id] } },
 *     delivery?: { recipients: [...] },
 *     bounce?: { bounceType, bouncedRecipients: [{ emailAddress }] },
 *     complaint?: { complainedRecipients: [{ emailAddress }] },
 *     open?: { timestamp },
 *     click?: { timestamp, link } }
 *
 * We update:
 *   - CAMPAIGN#<id>/STATS counters via ADD
 *   - CAMPAIGN#<id>/RCPT#<email> state + timestamps
 *   - SUPP#<email>/REASON#bounce|complaint on permanent bounce / any complaint
 */
export const handler: SNSHandler = async (event) => {
  for (const record of event.Records) {
    try {
      await processRecord(record);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(JSON.stringify({ level: 'error', msg: 'event-ingest-failed', err: msg }));
      // Swallow so one bad event doesn't block the batch. SNS retries on 5xx
      // from the whole invocation; individual parse failures shouldn't trigger
      // that (we'd just keep hitting them).
    }
  }
};

async function processRecord(record: SNSEventRecord): Promise<void> {
  const ses = JSON.parse(record.Sns.Message) as SesEvent;
  const campaignId = readCampaignId(ses);
  const email = firstRecipient(ses);
  const type = ses.eventType;
  console.log(JSON.stringify({ level: 'info', msg: 'ses-event', type, campaignId, email }));

  if (!campaignId || !email) return; // not one of ours

  switch (type) {
    case 'Send':
      // worker-send already set state=sent; no-op here (idempotent).
      break;
    case 'Delivery':
      await bumpStats(campaignId, { delivered: 1 });
      await setRcpt(campaignId, email, { state: 'delivered', deliveredAt: now() });
      break;
    case 'Open': {
      // `opened` counts every Open event (incl. multi-device, image-proxy
      // prefetches, scanner reloads). `uniqueOpened` counts the first event
      // per recipient. The conditional update on the RCPT row tells us
      // whether this is the first one; subsequent events still bump the
      // raw counter and refresh `lastOpenedAt`.
      const firstOpen = await claimFirstTimestamp(campaignId, email, 'openedAt');
      await bumpStats(campaignId, firstOpen ? { opened: 1, uniqueOpened: 1 } : { opened: 1 });
      if (!firstOpen) {
        await setRcpt(campaignId, email, { lastOpenedAt: now() });
      }
      break;
    }
    case 'Click': {
      const url = ses.click?.link ?? '';
      const firstClick = await claimFirstTimestamp(campaignId, email, 'clickedAt');
      await bumpStats(campaignId, firstClick ? { clicked: 1, uniqueClicked: 1 } : { clicked: 1 });
      await setRcpt(campaignId, email, { lastClickUrl: url, lastClickedAt: now() });
      // Per-URL counter row. uniqueClicks per link counted once per recipient
      // by conditional-adding the linkId into a String Set on the RCPT row.
      if (url) {
        const linkId = hashLink(url);
        const firstForRecipient = await claimFirstClickPerLink(campaignId, email, linkId);
        await bumpLinkStats(campaignId, linkId, url, firstForRecipient);
      }
      break;
    }
    case 'Bounce': {
      const bounceType = ses.bounce?.bounceType ?? 'Undetermined';
      const permanent = bounceType === 'Permanent';
      await bumpStats(campaignId, { bounced: 1 });
      await setRcpt(campaignId, email, { state: 'bounced', bouncedAt: now(), bounceType });
      if (permanent) {
        await applySuppression(ddb, TABLE, {
          email,
          scope: 'global',
          reason: 'bounce',
          source: 'ses',
          messageId: ses.mail.messageId,
        });
        await setContactStatus(email, 'bounced');
      }
      break;
    }
    case 'Complaint':
      await bumpStats(campaignId, { complained: 1 });
      await setRcpt(campaignId, email, { state: 'complained', complainedAt: now() });
      await applySuppression(ddb, TABLE, {
        email,
        scope: 'global',
        reason: 'complaint',
        source: 'ses',
        messageId: ses.mail.messageId,
      });
      await setContactStatus(email, 'unsubscribed');
      break;
    case 'Reject':
      await bumpStats(campaignId, { rejected: 1 });
      await setRcpt(campaignId, email, { state: 'rejected', rejectedAt: now() });
      break;
    case 'DeliveryDelay':
      await setRcpt(campaignId, email, { lastDelayAt: now() });
      break;
    case 'RenderingFailure':
      await bumpStats(campaignId, { failed: 1 });
      await setRcpt(campaignId, email, { state: 'failed', failedAt: now() });
      break;
    case 'Subscription':
      // List-Unsubscribe header one-click handled by SES. We also write SUPP
      // from our own /public/u endpoint, so this is informational.
      await bumpStats(campaignId, { unsubscribed: 1 });
      break;
    default:
      console.log(JSON.stringify({ level: 'warn', msg: 'unhandled-event-type', type }));
  }
}

// ── Dynamo ────────────────────────────────────────────────────────────────

async function bumpStats(campaignId: string, inc: Record<string, number>): Promise<void> {
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const parts = Object.entries(inc).map(([k, v], i) => {
    const n = `#k${i}`;
    const vn = `:v${i}`;
    names[n] = k;
    values[vn] = v;
    return `${n} ${vn}`;
  });
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { PK: `CAMPAIGN#${campaignId}`, SK: 'STATS' },
      UpdateExpression: 'ADD ' + parts.join(', '),
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }),
  );
}

/**
 * Sets `attr` to now() on the RCPT row only if it isn't already set, returning
 * true on success. Used to detect first-open and first-click per recipient
 * for the unique-rate counters.
 */
async function claimFirstTimestamp(
  campaignId: string,
  email: string,
  attr: 'openedAt' | 'clickedAt',
): Promise<boolean> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { PK: `CAMPAIGN#${campaignId}`, SK: `RCPT#${email}` },
        UpdateExpression: 'SET #a = :t',
        ConditionExpression: 'attribute_not_exists(#a)',
        ExpressionAttributeNames: { '#a': attr },
        ExpressionAttributeValues: { ':t': now() },
      }),
    );
    return true;
  } catch (e) {
    if ((e as { name?: string }).name === 'ConditionalCheckFailedException') return false;
    throw e;
  }
}

/** Truncated SHA-1 of the URL — collision-resistant within one campaign and
 *  short enough to keep the SK reasonable. */
function hashLink(url: string): string {
  return createHash('sha1').update(url).digest('base64url').slice(0, 16);
}

/**
 * Adds linkId to the recipient's `clickedLinks` String Set if not already
 * present. Returns true on first click of this URL by this recipient.
 */
async function claimFirstClickPerLink(
  campaignId: string,
  email: string,
  linkId: string,
): Promise<boolean> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { PK: `CAMPAIGN#${campaignId}`, SK: `RCPT#${email}` },
        UpdateExpression: 'ADD clickedLinks :u',
        ConditionExpression: 'attribute_not_exists(clickedLinks) OR NOT contains(clickedLinks, :u_str)',
        ExpressionAttributeValues: { ':u': new Set([linkId]), ':u_str': linkId },
      }),
    );
    return true;
  } catch (e) {
    if ((e as { name?: string }).name === 'ConditionalCheckFailedException') return false;
    throw e;
  }
}

/**
 * Per-URL counter row for the campaign. `clicks` counts every Click event,
 * `uniqueClicks` counts distinct recipients (incremented only on the first
 * click of this link by a given recipient). The row also memoizes the URL
 * itself so the link list endpoint can render without an extra lookup.
 */
async function bumpLinkStats(
  campaignId: string,
  linkId: string,
  url: string,
  firstForRecipient: boolean,
): Promise<void> {
  const addParts = ['clicks :one'];
  if (firstForRecipient) addParts.push('uniqueClicks :one');
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { PK: `CAMPAIGN#${campaignId}`, SK: `LINK#${linkId}` },
      UpdateExpression:
        `ADD ${addParts.join(', ')} SET #u = if_not_exists(#u, :url), firstSeenAt = if_not_exists(firstSeenAt, :t), lastSeenAt = :t`,
      ExpressionAttributeNames: { '#u': 'url' },
      ExpressionAttributeValues: { ':one': 1, ':url': url, ':t': now() },
    }),
  );
}

async function setRcpt(campaignId: string, email: string, patch: Record<string, unknown>): Promise<void> {
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const sets: string[] = [];
  Object.entries(patch).forEach(([k, v], i) => {
    if (v === undefined) return;
    const n = `#p${i}`;
    const vn = `:p${i}`;
    names[n] = k === 'state' ? 'state' : k;
    values[vn] = v;
    sets.push(`${n} = ${vn}`);
  });
  if (sets.length === 0) return;
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { PK: `CAMPAIGN#${campaignId}`, SK: `RCPT#${email}` },
      UpdateExpression: 'SET ' + sets.join(', '),
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }),
  );
}

async function setContactStatus(email: string, status: 'unsubscribed' | 'bounced'): Promise<void> {
  const at = now();
  const suppression =
    status === 'active' ? suppressionState() : suppressionState(status === 'bounced' ? 'bounce' : 'complaint', at);
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { PK: `CONTACT#${email}`, SK: 'PROFILE' },
      UpdateExpression:
        'SET #s = :s, updatedAt = :u, suppressed = :suppressed, GSI2PK = :gsi2pk, GSI2SK = :gsi2sk' +
        (suppression.suppressedAt ? ', suppressedAt = :suppressedAt, suppressionReason = :suppressionReason' : ''),
      ConditionExpression: 'attribute_exists(PK)',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: {
        ':s': status,
        ':u': at,
        ':suppressed': suppression.suppressed,
        ':suppressedAt': suppression.suppressedAt,
        ':suppressionReason': suppression.suppressionReason,
        ':gsi2pk': contactStatusIndexFields(
          email,
          status === 'bounced' ? 'bounced' : 'unsubscribed',
        ).GSI2PK,
        ':gsi2sk': contactStatusIndexFields(
          email,
          status === 'bounced' ? 'bounced' : 'unsubscribed',
        ).GSI2SK,
      },
    }),
  ).catch((e: unknown) => {
    // missing contact is fine — suppression is still recorded.
    const msg = e instanceof Error ? e.message : String(e);
    console.log(JSON.stringify({ level: 'info', msg: 'skip-contact-status', email, err: msg }));
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────

interface SesEvent {
  eventType: string;
  mail: {
    messageId: string;
    destination: string[];
    tags?: Record<string, string[]>;
  };
  delivery?: { recipients?: string[]; timestamp?: string };
  bounce?: { bounceType?: string; bouncedRecipients?: { emailAddress: string }[] };
  complaint?: { complainedRecipients?: { emailAddress: string }[] };
  open?: { timestamp?: string };
  click?: { timestamp?: string; link?: string };
}

function readCampaignId(e: SesEvent): string | null {
  const v = e.mail?.tags?.['campaign-id'];
  return v && v[0] ? v[0] : null;
}

function firstRecipient(e: SesEvent): string | null {
  if (e.bounce?.bouncedRecipients?.[0]?.emailAddress) return e.bounce.bouncedRecipients[0].emailAddress;
  if (e.complaint?.complainedRecipients?.[0]?.emailAddress) return e.complaint.complainedRecipients[0].emailAddress;
  if (e.delivery?.recipients?.[0]) return e.delivery.recipients[0];
  if (e.mail?.destination?.[0]) return e.mail.destination[0];
  return null;
}

function now(): string {
  return new Date().toISOString();
}

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}
