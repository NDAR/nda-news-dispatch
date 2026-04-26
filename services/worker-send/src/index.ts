import type { SQSHandler, SQSBatchResponse, SQSRecord } from 'aws-lambda';
import { createHmac } from 'node:crypto';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { loadSettings, renderFooterHtml, renderFooterText } from './footer';

const ses = new SESv2Client({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

const TABLE = mustEnv('TABLE_NAME');
const CONFIG_SET_NAME = mustEnv('CONFIG_SET_NAME');
const FROM_ADDRESS = mustEnv('FROM_ADDRESS');
const PUBLIC_BASE_URL = mustEnv('PUBLIC_BASE_URL');
// UNSUB_SECRET is intentionally derived from table name for MVP; once step 7
// introduces the public unsubscribe endpoint this will move to SSM.
const UNSUB_SECRET = process.env.UNSUB_SECRET ?? `dev-${TABLE}`;

interface SendJob {
  campaignId: string;
  email: string;
  name?: string;
  subject: string;
  html: string;
  /** Test sends bypass the per-recipient DDB write — they aren't tied to a
   *  real campaign and we don't want them polluting STATS or RCPT rows. */
  test?: boolean;
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
  const token = signUnsubToken(job.campaignId, job.email);
  const unsubUrl = `${PUBLIC_BASE_URL}/public/u?c=${encodeURIComponent(job.campaignId)}&e=${encodeURIComponent(
    job.email,
  )}&t=${token}`;
  const mailtoUnsub = `mailto:unsubscribe@${FROM_ADDRESS.replace(/.*@/, '').replace(/>.*/, '')}?subject=unsubscribe`;
  const headers = [
    { Name: 'List-Unsubscribe', Value: `<${mailtoUnsub}>, <${unsubUrl}>` },
    { Name: 'List-Unsubscribe-Post', Value: 'List-Unsubscribe=One-Click' },
    { Name: 'X-Campaign-Id', Value: job.campaignId },
  ];

  const settings = await loadSettings(TABLE);
  const finalHtml = job.html + renderFooterHtml(settings, unsubUrl);
  const finalText = stripHtml(job.html) + renderFooterText(settings, unsubUrl);

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
          Subject: { Data: job.subject, Charset: 'UTF-8' },
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

function signUnsubToken(campaignId: string, email: string): string {
  return createHmac('sha256', UNSUB_SECRET).update(`${campaignId}|${email}`).digest('base64url');
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
