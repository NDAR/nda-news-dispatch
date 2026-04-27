import type { APIGatewayProxyHandler, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  applySuppression,
  contactStatusIndexFields,
  verifyUnsubscribeToken,
  type OrgSettings,
} from '../../../packages/shared/src';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

const TABLE = mustEnv('TABLE_NAME');
const UNSUB_SECRET = mustEnv('UNSUB_SECRET');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const SETTINGS_TTL_MS = 60_000;
let cachedSettings: { at: number; settings: OrgSettings } | null = null;

const TYPE_NAME_TTL_MS = 60_000;
const typeNameCache = new Map<string, { at: number; name?: string }>();

async function loadSettings(): Promise<OrgSettings> {
  const now = Date.now();
  if (cachedSettings && now - cachedSettings.at < SETTINGS_TTL_MS) return cachedSettings.settings;
  const res = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: { PK: 'ORG#default', SK: 'SETTINGS' } }),
  );
  const settings: OrgSettings = res.Item
    ? {
        footerHtml: typeof res.Item.footerHtml === 'string' ? res.Item.footerHtml : '',
        senderName: typeof res.Item.senderName === 'string' ? res.Item.senderName : undefined,
        senderAddress:
          typeof res.Item.senderAddress === 'string' ? res.Item.senderAddress : undefined,
      }
    : { footerHtml: '' };
  cachedSettings = { at: now, settings };
  return settings;
}

interface CampaignContext {
  campaignId: string;
  typeId?: string;
  typeName?: string;
}

async function loadCampaignContext(campaignId: string): Promise<CampaignContext> {
  const res = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: { PK: `CAMPAIGN#${campaignId}`, SK: 'META' } }),
  );
  const typeId = typeof res.Item?.typeId === 'string' ? res.Item.typeId : undefined;
  const typeName = typeId ? await loadTypeName(typeId) : undefined;
  return { campaignId, typeId, typeName };
}

async function loadTypeName(typeId: string): Promise<string | undefined> {
  const now = Date.now();
  const cached = typeNameCache.get(typeId);
  if (cached && now - cached.at < TYPE_NAME_TTL_MS) return cached.name;
  const res = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: { PK: `TYPE#${typeId}`, SK: 'LATEST' } }),
  );
  const name = typeof res.Item?.name === 'string' ? res.Item.name : undefined;
  typeNameCache.set(typeId, { at: now, name });
  return name;
}

/**
 * Public, unauthenticated endpoints for unsubscribe:
 *   GET  /public/u             — browser-click unsubscribe; per-type by default
 *   POST /public/u             — RFC 8058 one-click unsubscribe (per-type)
 *   POST /public/u?scope=all   — escalate from confirmation page to global
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  const qs = (event.queryStringParameters ?? {}) as Record<string, string | undefined>;
  const campaignId = qs.c ?? '';
  const email = (qs.e ?? '').toLowerCase();
  const token = qs.t ?? '';
  const scopeParam = (qs.scope ?? '').toLowerCase();
  const escalateGlobal = scopeParam === 'all' || scopeParam === 'global';

  if (!campaignId || !EMAIL_RE.test(email) || !token) {
    return html(400, errorPage('Invalid unsubscribe link'));
  }
  if (!verifyToken(campaignId, email, token)) {
    return html(400, errorPage('This unsubscribe link has expired or is invalid'));
  }

  let context: CampaignContext;
  try {
    context = await loadCampaignContext(campaignId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ level: 'error', msg: 'load-campaign-failed', campaignId, err: msg }));
    context = { campaignId };
  }

  // If the operator clicks "Unsubscribe from all" on the confirmation page
  // (or a partner integration POSTs ?scope=all), record both layers — global
  // hard suppression plus, if there's a typeId, the per-type entry too so
  // history is unambiguous.
  const scope: 'global' | 'type' = escalateGlobal || !context.typeId ? 'global' : 'type';

  try {
    await recordUnsubscribe(context, email, scope);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ level: 'error', msg: 'unsubscribe-failed', email, campaignId, err: msg }));
    return html(500, errorPage('Sorry — something went wrong. Try again, or reply to the email.'));
  }

  if (event.httpMethod === 'POST' && !escalateGlobal) {
    // RFC 8058 one-click — mail clients want a 200 with no body.
    return { statusCode: 200, headers: { 'content-type': 'text/plain' }, body: 'OK' };
  }

  const settings = await loadSettings().catch(() => ({ footerHtml: '' } as OrgSettings));
  return html(
    200,
    confirmationPage({
      email,
      settings,
      context,
      scope,
      token,
    }),
  );
};

async function recordUnsubscribe(
  context: CampaignContext,
  email: string,
  scope: 'global' | 'type',
): Promise<void> {
  const at = new Date().toISOString();
  await applySuppression(ddb, TABLE, {
    email,
    scope,
    typeId: scope === 'type' ? context.typeId : undefined,
    reason: 'unsubscribe',
    source: 'link',
    campaignId: context.campaignId,
    at,
  });

  // For the global path we also flip the contact's status to `unsubscribed`
  // and refresh the GSI2 partition. Per-type opt-outs leave the contact
  // active for sends from other types.
  if (scope === 'global') {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { PK: `CONTACT#${email}`, SK: 'PROFILE' },
        UpdateExpression:
          'SET #s = :s, unsubscribedAt = :u, updatedAt = :u, suppressedAt = :u, suppressionReason = :r, GSI2PK = :gsi2pk, GSI2SK = :gsi2sk',
        ConditionExpression: 'attribute_exists(PK)',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: {
          ':s': 'unsubscribed',
          ':u': at,
          ':r': 'unsubscribe',
          ':gsi2pk': contactStatusIndexFields(email, 'unsubscribed').GSI2PK,
          ':gsi2sk': contactStatusIndexFields(email, 'unsubscribed').GSI2SK,
        },
      }),
    ).catch(() => { /* contact may not exist (forwarded mail) */ });
  }

  await Promise.all([
    ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { PK: `CAMPAIGN#${context.campaignId}`, SK: 'STATS' },
        UpdateExpression: 'ADD unsubscribed :one',
        ExpressionAttributeValues: { ':one': 1 },
      }),
    ).catch(() => { /* campaign stats row absent for test sends */ }),
    ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { PK: `CAMPAIGN#${context.campaignId}`, SK: `RCPT#${email}` },
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

interface ConfirmationOpts {
  email: string;
  settings: OrgSettings;
  context: CampaignContext;
  scope: 'global' | 'type';
  token: string;
}

function confirmationPage(opts: ConfirmationOpts): string {
  const footerLine = senderFooterLine(opts.settings);
  const typeLabel = opts.context.typeName ? escapeHtml(opts.context.typeName) : 'this newsletter';
  const brandLabel = opts.settings.senderName
    ? escapeHtml(opts.settings.senderName)
    : 'this sender';

  const headline =
    opts.scope === 'global'
      ? "You've been unsubscribed from all emails"
      : `You've been unsubscribed from ${typeLabel}`;

  const detail =
    opts.scope === 'global'
      ? `<code>${escapeHtml(opts.email)}</code> will no longer receive any newsletters from us.`
      : `<code>${escapeHtml(opts.email)}</code> has been removed from <strong>${typeLabel}</strong>. Other newsletters you're subscribed to will keep arriving.`;

  // Only show the escalate-to-global form when we just processed a per-type
  // unsubscribe. After someone has globally opted out, the form is redundant.
  const escalateAction =
    `?c=${encodeURIComponent(opts.context.campaignId)}` +
    `&e=${encodeURIComponent(opts.email)}` +
    `&t=${encodeURIComponent(opts.token)}&scope=all`;
  const escalateBlock =
    opts.scope === 'type'
      ? `
        <form method="POST" action="${escapeHtml(escalateAction)}" class="escalate">
          <p>Want to stop all emails from ${brandLabel}, not just ${typeLabel}?</p>
          <button type="submit" class="link">Unsubscribe from everything</button>
        </form>`
      : '';

  return `<!doctype html><html lang="en"><head><meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Unsubscribed</title>
  <style>
    body{font-family:'Source Serif 4',Georgia,serif;background:#faf7f1;color:#2a2420;margin:0;min-height:100vh;display:grid;place-items:center;padding:24px}
    .card{max-width:520px;width:100%;background:#fff;border:1px solid #e6decf;border-radius:8px;padding:36px 32px;box-shadow:0 1px 2px rgba(0,0,0,.04)}
    h1{font-size:24px;margin:0 0 12px;letter-spacing:-.01em}
    p{font-size:15px;line-height:1.6;color:#554a40;margin:8px 0}
    code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:#f4efe5;padding:2px 6px;border-radius:3px;font-size:13px}
    strong{color:#2a2420}
    .muted{color:#8a7f70;font-size:13px;margin-top:22px;border-top:1px solid #e6decf;padding-top:14px;white-space:pre-line}
    form.escalate{margin-top:18px;padding-top:14px;border-top:1px solid #e6decf}
    form.escalate p{font-size:13px;color:#8a7f70;margin:0 0 8px}
    button.link{font:inherit;font-size:13px;color:#9b3b21;background:none;border:none;padding:0;cursor:pointer;text-decoration:underline}
    button.link:hover{color:#7a2d18}
  </style></head>
  <body><div class="card">
    <h1>${escapeHtml(headline)}</h1>
    <p>${detail}</p>
    <p>If this was a mistake, reply to any recent dispatch and we'll restore you.</p>
    ${escalateBlock}
    ${footerLine ? `<p class="muted">${footerLine}</p>` : ''}
  </div></body></html>`;
}

function errorPage(message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8" />
  <title>Unsubscribe</title>
  <style>
    body{font-family:'Source Serif 4',Georgia,serif;background:#faf7f1;color:#2a2420;margin:0;min-height:100vh;display:grid;place-items:center;padding:24px}
    .card{max-width:520px;width:100%;background:#fff;border:1px solid #e6decf;border-radius:8px;padding:36px 32px}
    h1{font-size:22px;margin:0 0 12px}
    p{font-size:15px;line-height:1.6;color:#554a40}
  </style></head>
  <body><div class="card"><h1>Unsubscribe</h1><p>${escapeHtml(message)}</p></div></body></html>`;
}

function senderFooterLine(settings: OrgSettings): string {
  const parts: string[] = [];
  if (settings.senderName) parts.push(escapeHtml(settings.senderName));
  if (settings.senderAddress) parts.push(escapeHtml(settings.senderAddress).replace(/\n/g, '<br/>'));
  return parts.join(' · ');
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
