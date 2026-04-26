import type { APIGatewayProxyHandler, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  contactStatusIndexFields,
  suppressionState,
  verifyUnsubscribeToken,
} from '../../../packages/shared/src';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

const TABLE = mustEnv('TABLE_NAME');
const UNSUB_SECRET = mustEnv('UNSUB_SECRET');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Public, unauthenticated endpoints for unsubscribe:
 *   GET  /public/u  — browser-click unsubscribe; validates HMAC, returns confirmation HTML
 *   POST /public/u  — RFC 8058 one-click unsubscribe (headers: List-Unsubscribe + List-Unsubscribe-Post)
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  const { c, e, t } = (event.queryStringParameters ?? {}) as Record<string, string | undefined>;
  const campaignId = c ?? '';
  const email = (e ?? '').toLowerCase();
  const token = t ?? '';

  if (!campaignId || !EMAIL_RE.test(email) || !token) {
    return html(400, errorPage('Invalid unsubscribe link'));
  }
  if (!verifyToken(campaignId, email, token)) {
    return html(400, errorPage('This unsubscribe link has expired or is invalid'));
  }

  try {
    await recordUnsubscribe(campaignId, email);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ level: 'error', msg: 'unsubscribe-failed', email, campaignId, err: msg }));
    return html(500, errorPage('Sorry — something went wrong. Try again, or reply to the email.'));
  }

  if (event.httpMethod === 'POST') {
    // RFC 8058 one-click — mail clients want a 200 with no body.
    return { statusCode: 200, headers: { 'content-type': 'text/plain' }, body: 'OK' };
  }
  return html(200, confirmationPage(email));
};

async function recordUnsubscribe(campaignId: string, email: string): Promise<void> {
  const at = new Date().toISOString();
  const suppression = suppressionState('unsubscribe', at);
  await Promise.all([
    ddb.send(
      new PutCommand({
        TableName: TABLE,
        Item: {
          PK: `SUPP#${email}`,
          SK: 'REASON#unsubscribe',
          email,
          reason: 'unsubscribe',
          source: 'link',
          campaignId,
          addedAt: at,
        },
      }),
    ),
    ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { PK: `CONTACT#${email}`, SK: 'PROFILE' },
        UpdateExpression:
          'SET #s = :s, unsubscribedAt = :u, updatedAt = :u, suppressed = :suppressed, suppressedAt = :suppressedAt, suppressionReason = :suppressionReason, GSI2PK = :gsi2pk, GSI2SK = :gsi2sk',
        ConditionExpression: 'attribute_exists(PK)',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: {
          ':s': 'unsubscribed',
          ':u': at,
          ':suppressed': suppression.suppressed,
          ':suppressedAt': suppression.suppressedAt,
          ':suppressionReason': suppression.suppressionReason,
          ':gsi2pk': contactStatusIndexFields(email, 'unsubscribed').GSI2PK,
          ':gsi2sk': contactStatusIndexFields(email, 'unsubscribed').GSI2SK,
        },
      }),
    ).catch(() => { /* contact may not exist in our table (forwarded mail) */ }),
    ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { PK: `CAMPAIGN#${campaignId}`, SK: 'STATS' },
        UpdateExpression: 'ADD unsubscribed :one',
        ExpressionAttributeValues: { ':one': 1 },
      }),
    ).catch(() => { /* campaign stats row absent for test sends */ }),
    ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { PK: `CAMPAIGN#${campaignId}`, SK: `RCPT#${email}` },
        UpdateExpression: 'SET #s = :s, unsubscribedAt = :u',
        ExpressionAttributeNames: { '#s': 'state' },
        ExpressionAttributeValues: { ':s': 'unsubscribed', ':u': at },
      }),
    ).catch(() => { /* recipient row absent (test send or stale link) */ }),
  ]);
}

function verifyToken(campaignId: string, email: string, token: string): boolean {
  return verifyUnsubscribeToken(UNSUB_SECRET, campaignId, email, token);
}

function confirmationPage(email: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Unsubscribed · NDA Dispatch</title>
  <style>
    body{font-family:'Source Serif 4',Georgia,serif;background:#faf7f1;color:#2a2420;margin:0;min-height:100vh;display:grid;place-items:center;padding:24px}
    .card{max-width:520px;width:100%;background:#fff;border:1px solid #e6decf;border-radius:8px;padding:36px 32px;box-shadow:0 1px 2px rgba(0,0,0,.04)}
    h1{font-size:24px;margin:0 0 12px;letter-spacing:-.01em}
    p{font-size:15px;line-height:1.6;color:#554a40;margin:8px 0}
    code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:#f4efe5;padding:2px 6px;border-radius:3px;font-size:13px}
    .muted{color:#8a7f70;font-size:13px;margin-top:22px;border-top:1px solid #e6decf;padding-top:14px}
  </style></head>
  <body><div class="card">
    <h1>You've been unsubscribed</h1>
    <p><code>${escapeHtml(email)}</code> has been removed from future mailings.</p>
    <p>If this was a mistake, reply to any recent dispatch and we'll restore you.</p>
    <p class="muted">NDA Dispatch · National Institute of Mental Health Data Archive</p>
  </div></body></html>`;
}

function errorPage(message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8" />
  <title>Unsubscribe · NDA Dispatch</title>
  <style>
    body{font-family:'Source Serif 4',Georgia,serif;background:#faf7f1;color:#2a2420;margin:0;min-height:100vh;display:grid;place-items:center;padding:24px}
    .card{max-width:520px;width:100%;background:#fff;border:1px solid #e6decf;border-radius:8px;padding:36px 32px}
    h1{font-size:22px;margin:0 0 12px}
    p{font-size:15px;line-height:1.6;color:#554a40}
  </style></head>
  <body><div class="card"><h1>Unsubscribe</h1><p>${escapeHtml(message)}</p></div></body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function html(status: number, body: string): APIGatewayProxyResult {
  return {
    statusCode: status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    },
    body,
  };
}

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}
