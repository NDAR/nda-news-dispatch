import type { SQSHandler, SQSBatchResponse, SQSRecord } from 'aws-lambda';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { createUnsubscribeToken } from '../../../packages/shared/src/unsubscribe';
import { createViewToken } from '../../../packages/shared/src/viewInBrowser';
import {
  loadSettings,
  renderFooterHtml,
  renderFooterText,
  renderViewInBrowserBar,
} from './footer';

const ses = new SESv2Client({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

const TABLE = mustEnv('TABLE_NAME');
const CONFIG_SET_NAME = mustEnv('CONFIG_SET_NAME');
const FROM_ADDRESS = mustEnv('FROM_ADDRESS');
const PUBLIC_BASE_URL = mustEnv('PUBLIC_BASE_URL');
const UNSUB_SECRET = mustEnv('UNSUB_SECRET');

interface SendJob {
  campaignId: string;
  email: string;
  name?: string;
  /** Test sends bypass the per-recipient DDB write and carry their own subject
   *  + html inline because no CAMPAIGN#{id}#META row exists for them. Real
   *  campaign sends omit these and the worker pulls them from META. */
  test?: boolean;
  subject?: string;
  html?: string;
}

interface CampaignContent {
  subject: string;
  html: string;
}

const CAMPAIGN_TTL_MS = 60_000;
const cachedCampaigns = new Map<string, { at: number; content: CampaignContent }>();

async function loadCampaignContent(campaignId: string): Promise<CampaignContent> {
  const now = Date.now();
  const hit = cachedCampaigns.get(campaignId);
  if (hit && now - hit.at < CAMPAIGN_TTL_MS) return hit.content;
  const res = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: { PK: `CAMPAIGN#${campaignId}`, SK: 'META' } }),
  );
  if (!res.Item) throw new Error(`Campaign ${campaignId} not found`);
  const content: CampaignContent = {
    subject: typeof res.Item.subject === 'string' ? res.Item.subject : '',
    html: typeof res.Item.html === 'string' ? res.Item.html : '',
  };
  cachedCampaigns.set(campaignId, { at: now, content });
  return content;
}

/**
 * SQS trigger — one batch up to 10 records. Each record is a SendJob. We use
 * partial-batch responses so a single failure doesn't retry the whole batch.
 */
export const handler: SQSHandler = async (event) => {
  const failures: SQSBatchResponse['batchItemFailures'] = [];
  for (const record of event.Records) {
    try {
      await processRecord(record);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(
        JSON.stringify({ level: 'error', msg: 'send-failed', messageId: record.messageId, err: msg }),
      );
      failures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures: failures };
};

async function processRecord(record: SQSRecord): Promise<void> {
  const job = JSON.parse(record.body) as SendJob;
  let subject: string;
  let html: string;
  if (job.test) {
    subject = job.subject ?? '';
    html = job.html ?? '';
  } else {
    const content = await loadCampaignContent(job.campaignId);
    subject = content.subject;
    html = content.html;
  }
  const token = createUnsubscribeToken(UNSUB_SECRET, job.campaignId, job.email);
  const unsubUrl = `${PUBLIC_BASE_URL}/public/u?c=${encodeURIComponent(job.campaignId)}&e=${encodeURIComponent(
    job.email,
  )}&t=${token}`;
  const viewToken = createViewToken(UNSUB_SECRET, job.campaignId, job.email);
  const viewUrl = `${PUBLIC_BASE_URL}/public/v?c=${encodeURIComponent(job.campaignId)}&e=${encodeURIComponent(
    job.email,
  )}&t=${viewToken}`;
  const mailtoUnsub = `mailto:unsubscribe@${FROM_ADDRESS.replace(/.*@/, '').replace(/>.*/, '')}?subject=unsubscribe`;
  // Note: we deliberately do NOT include `List-Unsubscribe-Post:
  // List-Unsubscribe=One-Click`. RFC 8058 one-click is regularly fired by
  // enterprise link-scanning gateways (Microsoft Defender Safe Links,
  // Proofpoint URL Defense, Mimecast, Barracuda, etc.) before delivery,
  // unsubscribing real subscribers without their action. Clients that
  // honor the bare `List-Unsubscribe` header still surface a native
  // "Unsubscribe" affordance — it just opens the URL instead of POSTing
  // to it, which routes through our confirmation page.
  const headers = [
    { Name: 'List-Unsubscribe', Value: `<${mailtoUnsub}>, <${unsubUrl}>` },
    { Name: 'X-Campaign-Id', Value: job.campaignId },
  ];

  const settings = await loadSettings(TABLE);
  // Test sends don't have a campaign META row, so the /public/v handler can't
  // resolve them — omit the view-in-browser bar to avoid a dead link.
  const viewBarHtml = job.test ? '' : renderViewInBrowserBar(viewUrl);
  const viewBarText = job.test ? '' : `View in browser: ${viewUrl}\n\n`;
  const finalHtml = viewBarHtml + html + renderFooterHtml(settings, unsubUrl);
  const finalText = viewBarText + stripHtml(html) + renderFooterText(settings, unsubUrl);

  const res = await ses.send(
    new SendEmailCommand({
      FromEmailAddress: FROM_ADDRESS,
      Destination: { ToAddresses: [job.email] },
      ConfigurationSetName: CONFIG_SET_NAME,
      EmailTags: [
        { Name: 'campaign-id', Value: job.campaignId },
        { Name: 'env', Value: process.env.ENV_NAME ?? 'dev' },
      ],
      Content: {
        Simple: {
          Subject: { Data: subject, Charset: 'UTF-8' },
          Body: {
            Html: { Data: finalHtml, Charset: 'UTF-8' },
            Text: { Data: finalText, Charset: 'UTF-8' },
          },
          Headers: headers,
        },
      },
    }),
  );

  if (job.test) return;

  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { PK: `CAMPAIGN#${job.campaignId}`, SK: `RCPT#${job.email}` },
      UpdateExpression: 'SET #s = :s, sentAt = :t, messageId = :m',
      ExpressionAttributeNames: { '#s': 'state' },
      ExpressionAttributeValues: {
        ':s': 'sent',
        ':t': new Date().toISOString(),
        ':m': res.MessageId ?? '',
      },
    }),
  );
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 10_000);
}

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}
