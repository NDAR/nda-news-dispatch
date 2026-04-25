import type { SNSHandler, SNSEventRecord } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  UpdateCommand,
  PutCommand,
} from '@aws-sdk/lib-dynamodb';

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
    case 'Open':
      await bumpStats(campaignId, { opened: 1 });
      await setRcpt(campaignId, email, { openedAt: now() });
      break;
    case 'Click':
      await bumpStats(campaignId, { clicked: 1 });
      await setRcpt(campaignId, email, { clickedAt: now(), lastClickUrl: ses.click?.link });
      break;
    case 'Bounce': {
      const bounceType = ses.bounce?.bounceType ?? 'Undetermined';
      const permanent = bounceType === 'Permanent';
      await bumpStats(campaignId, { bounced: 1 });
      await setRcpt(campaignId, email, { state: 'bounced', bouncedAt: now(), bounceType });
      if (permanent) {
        await suppress(email, 'bounce', ses.mail.messageId);
        await setContactStatus(email, 'bounced');
      }
      break;
    }
    case 'Complaint':
      await bumpStats(campaignId, { complained: 1 });
      await setRcpt(campaignId, email, { state: 'complained', complainedAt: now() });
      await suppress(email, 'complaint', ses.mail.messageId);
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

async function suppress(email: string, reason: 'bounce' | 'complaint', messageId: string): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        PK: `SUPP#${email}`,
        SK: `REASON#${reason}`,
        email,
        reason,
        source: 'ses',
        messageId,
        addedAt: now(),
      },
    }),
  );
}

async function setContactStatus(email: string, status: string): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { PK: `CONTACT#${email}`, SK: 'PROFILE' },
      UpdateExpression: 'SET #s = :s, updatedAt = :u',
      ConditionExpression: 'attribute_exists(PK)',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':s': status, ':u': now() },
    }),
  ).catch((e) => {
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
