import type { APIGatewayProxyHandler, APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import {
  contactStatusIndexFields,
  createConfirmToken,
  verifyConfirmToken,
  type OrgSettings,
} from '../../../packages/shared/src';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const ses = new SESv2Client({});

const TABLE = mustEnv('TABLE_NAME');
const UNSUB_SECRET = mustEnv('UNSUB_SECRET');
const PUBLIC_BASE_URL = mustEnv('PUBLIC_BASE_URL');
const FROM_ADDRESS = mustEnv('FROM_ADDRESS');
const CONFIG_SET_NAME = process.env.CONFIG_SET_NAME ?? '';
const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET ?? '';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const SETTINGS_TTL_MS = 60_000;
let cachedSettings: { at: number; settings: OrgSettings } | null = null;

/**
 * Public, unauthenticated subscribe endpoints:
 *
 *   GET  /public/subscribe/types      — list newsletter types (id + name)
 *                                       so the form can show a chooser.
 *   POST /public/subscribe            — accept email + optional name +
 *                                       optional typeId. Validates a
 *                                       honeypot field, optionally a
 *                                       Cloudflare Turnstile token, then
 *                                       writes a PENDING_OPTIN row and
 *                                       sends a confirmation email.
 *   GET  /public/subscribe/confirm    — verify the HMAC-signed link from
 *                                       the confirmation email, promote
 *                                       PENDING_OPTIN to a real CONTACT
 *                                       row (or refresh tags if the
 *                                       contact already exists), then
 *                                       redirect to the SPA's
 *                                       /subscribe/confirmed page.
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  try {
    const route = `${event.httpMethod} ${event.resource}`;
    switch (route) {
      case 'GET /public/subscribe/types':
        return ok(await listPublicTypes());
      case 'POST /public/subscribe':
        return ok(await postSubscribe(event));
      case 'GET /public/subscribe/confirm':
        return await getConfirm(event);
      default:
        return errJson(404, 'not-found', `No route for ${route}`);
    }
  } catch (e) {
    if (e instanceof HttpError) return errJson(e.status, e.code, e.message);
    const msg = e instanceof Error ? e.message : String(e);
    console.error(JSON.stringify({ level: 'error', msg: 'subscribe-error', err: msg }));
    return errJson(500, 'internal-error', 'Unexpected server error');
  }
};

// ── Routes ─────────────────────────────────────────────────────────────────

interface PublicType {
  id: string;
  name: string;
  description?: string;
}

async function listPublicTypes(): Promise<{ items: PublicType[] }> {
  // Reuse the GSI1 listing pattern from api-admin/types.ts so the public
  // form can show whatever types are configured. Archived types are hidden.
  const res = await ddb.send(
    new (await import('@aws-sdk/lib-dynamodb')).QueryCommand({
      TableName: TABLE,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk',
      ExpressionAttributeValues: { ':pk': 'TYPE#latest' },
    }),
  );
  const items = (res.Items ?? [])
    .filter((it: Record<string, unknown>) =>
      it.archived !== true && it.publicSubscribable === true,
    )
    .map((it: Record<string, unknown>) => ({
      id: String(it.id ?? ''),
      name: String(it.name ?? ''),
      description: typeof it.description === 'string' ? it.description : undefined,
    }))
    .filter((t: PublicType) => t.id && t.name)
    .sort((a: PublicType, b: PublicType) => a.name.localeCompare(b.name));
  return { items };
}

interface SubscribeBody {
  email?: string;
  name?: string;
  typeId?: string;
  /** Honeypot — bots that auto-fill every input will populate this. */
  website?: string;
  /** Cloudflare Turnstile token, when configured. */
  turnstileToken?: string;
}

async function postSubscribe(event: APIGatewayProxyEvent): Promise<{ ok: true; pending: true }> {
  const body = parseBody<SubscribeBody>(event);

  // Honeypot. Bots tend to fill every field; real users never see this one.
  // Returning a normal success response keeps the bot from learning we
  // detected it (and probing for a different angle).
  if (typeof body.website === 'string' && body.website.trim() !== '') {
    console.log(JSON.stringify({ level: 'info', msg: 'subscribe-honeypot', email: body.email }));
    return { ok: true, pending: true };
  }

  const email = (body.email ?? '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'invalid-email', 'Please enter a valid email address.');
  const name = (body.name ?? '').trim().slice(0, 200);
  const typeId = (body.typeId ?? '').trim() || undefined;

  if (!await verifyTurnstile(body.turnstileToken, sourceIp(event))) {
    throw new HttpError(400, 'turnstile-failed', 'Could not verify the captcha. Please reload and try again.');
  }

  // Reject if the address is on the global suppression list — we don't want
  // to spam people who hard-bounced or complained. Per-type suppressions
  // don't block sign-up (the user is asking back in).
  const suppressed = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: { PK: `SUPP#${email}`, SK: 'TYPE#GLOBAL' } }),
  ).catch(() => null);
  if (suppressed?.Item) {
    // Same opaque success response — no list-leak signal.
    console.log(JSON.stringify({ level: 'info', msg: 'subscribe-globally-suppressed', email }));
    return { ok: true, pending: true };
  }

  if (typeId) {
    // Validate the typeId against the actual types so an attacker can't
    // create stray PENDING rows for arbitrary strings, AND require that
    // the type was opted in for public sign-up — admins explicitly mark
    // which types accept self-service subscribers.
    const t = await ddb.send(
      new GetCommand({ TableName: TABLE, Key: { PK: `TYPE#${typeId}`, SK: 'LATEST' } }),
    ).catch(() => null);
    if (!t?.Item || t.Item.archived === true || t.Item.publicSubscribable !== true) {
      throw new HttpError(404, 'type-not-found', 'That newsletter is no longer available.');
    }
  }

  const now = new Date();
  const at = now.toISOString();
  // PENDING_OPTIN row carries everything we need at confirm time. TTL
  // attribute matches DDB's `ttl` config — DDB scrubs unconfirmed rows
  // automatically after 48h.
  const ttlSec = Math.floor(now.getTime() / 1000) + 48 * 60 * 60;
  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        PK: `PENDING_OPTIN#${email}`,
        SK: typeId ? `TYPE#${typeId}` : 'TYPE#*',
        email,
        name: name || undefined,
        typeId,
        createdAt: at,
        ip: sourceIp(event),
        ttl: ttlSec,
      },
    }),
  );

  const token = createConfirmToken(UNSUB_SECRET, email, typeId);
  const confirmUrl = `${PUBLIC_BASE_URL}/public/subscribe/confirm`
    + `?e=${encodeURIComponent(email)}`
    + (typeId ? `&type=${encodeURIComponent(typeId)}` : '')
    + `&t=${encodeURIComponent(token)}`;

  await sendConfirmationEmail({ email, name, typeId, confirmUrl });
  return { ok: true, pending: true };
}

async function getConfirm(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const qs = (event.queryStringParameters ?? {}) as Record<string, string | undefined>;
  const email = (qs.e ?? '').toLowerCase();
  const typeId = (qs.type ?? '').trim() || undefined;
  const token = qs.t ?? '';
  if (!EMAIL_RE.test(email) || !token) {
    return redirect(`${PUBLIC_BASE_URL}/subscribe/error`);
  }
  if (!verifyConfirmToken(UNSUB_SECRET, email, typeId, token)) {
    return redirect(`${PUBLIC_BASE_URL}/subscribe/error?reason=expired`);
  }

  // Look up the PENDING_OPTIN row primarily for the captured `name`. Token
  // signature alone is sufficient proof the user clicked their own
  // confirmation link, but the row carries optional metadata.
  const pendingSk = typeId ? `TYPE#${typeId}` : 'TYPE#*';
  const pending = await ddb.send(
    new GetCommand({
      TableName: TABLE,
      Key: { PK: `PENDING_OPTIN#${email}`, SK: pendingSk },
    }),
  ).catch(() => null);
  const name = typeof pending?.Item?.name === 'string' ? pending.Item.name : '';

  await upsertConfirmedContact(email, name, typeId);

  // Best-effort cleanup. If the row is gone (TTL'd or replayed) we still
  // succeed — the SPA-confirmed-page is what the user sees.
  await ddb.send(
    new (await import('@aws-sdk/lib-dynamodb')).DeleteCommand({
      TableName: TABLE,
      Key: { PK: `PENDING_OPTIN#${email}`, SK: pendingSk },
    }),
  ).catch(() => undefined);

  const target = `${PUBLIC_BASE_URL}/subscribe/confirmed`
    + (typeId ? `?type=${encodeURIComponent(typeId)}` : '');
  return redirect(target);
}

// ── Helpers ────────────────────────────────────────────────────────────────

async function upsertConfirmedContact(
  email: string,
  name: string,
  typeId: string | undefined,
): Promise<void> {
  // Pull defaultTags from the type record if a typeId was confirmed; merge
  // those into whatever tags the contact already has so a re-subscribe
  // doesn't strip out tags an admin manually applied.
  let defaultTags: string[] = [];
  if (typeId) {
    const t = await ddb.send(
      new GetCommand({ TableName: TABLE, Key: { PK: `TYPE#${typeId}`, SK: 'LATEST' } }),
    ).catch(() => null);
    const raw = t?.Item?.defaultTags;
    if (Array.isArray(raw)) defaultTags = raw.filter((x): x is string => typeof x === 'string');
  }

  const existing = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: { PK: `CONTACT#${email}`, SK: 'PROFILE' } }),
  ).catch(() => null);
  const prevTags: string[] = Array.isArray(existing?.Item?.tags)
    ? (existing!.Item!.tags as string[]).filter((x): x is string => typeof x === 'string')
    : [];
  const tags = mergeUniq(prevTags, defaultTags);
  const now = new Date().toISOString();

  // Confirming an opt-in re-activates the contact even if they were
  // previously `unsubscribed`. We also clear any per-type opt-out for the
  // confirmed type — the user is explicitly asking back in.
  const sets: string[] = [
    'email = :email',
    '#name = :name',
    'tags = :tags',
    '#status = :active',
    'updatedAt = :u',
    'joined = if_not_exists(joined, :joinedDate)',
    'GSI2PK = :gsi2pk',
    'GSI2SK = :gsi2sk',
  ];
  const removes: string[] = ['unsubscribedAt', 'bouncedAt'];
  const values: Record<string, unknown> = {
    ':email': email,
    ':name': name || existing?.Item?.name || email.split('@')[0],
    ':tags': tags,
    ':active': 'active',
    ':u': now,
    ':joinedDate': now.slice(0, 10),
    ':gsi2pk': contactStatusIndexFields(email, 'active').GSI2PK,
    ':gsi2sk': contactStatusIndexFields(email, 'active').GSI2SK,
  };
  const names: Record<string, string> = { '#name': 'name', '#status': 'status' };

  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { PK: `CONTACT#${email}`, SK: 'PROFILE' },
      UpdateExpression: 'SET ' + sets.join(', ') + ' REMOVE ' + removes.join(', '),
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }),
  );

  // Tag index rows so the audience filter can find them.
  for (const tag of tags) {
    await ddb.send(
      new PutCommand({
        TableName: TABLE,
        Item: {
          PK: `CONTACT#${email}`,
          SK: `TAG#${tag}`,
          GSI1PK: `TAG#${tag}`,
          GSI1SK: `CONTACT#${email}`,
          email,
        },
      }),
    ).catch(() => undefined);
  }

  // If the contact had a per-type opt-out for this type, lift it — they're
  // asking to receive it again. Other per-type opt-outs are preserved.
  if (typeId) {
    await ddb.send(
      new (await import('@aws-sdk/lib-dynamodb')).DeleteCommand({
        TableName: TABLE,
        Key: { PK: `SUPP#${email}`, SK: `TYPE#${typeId}` },
      }),
    ).catch(() => undefined);
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { PK: `CONTACT#${email}`, SK: 'PROFILE' },
        UpdateExpression: 'DELETE suppressedTypes :tset',
        ExpressionAttributeValues: { ':tset': new Set([typeId]) },
      }),
    ).catch(() => undefined);
  }
}

function mergeUniq(a: string[], b: string[]): string[] {
  const out = new Set<string>();
  for (const t of a) out.add(t);
  for (const t of b) out.add(t);
  return [...out];
}

interface ConfirmEmailInput {
  email: string;
  name: string;
  typeId: string | undefined;
  confirmUrl: string;
}

async function sendConfirmationEmail(input: ConfirmEmailInput): Promise<void> {
  const settings = await loadSettings();
  const senderName = settings.senderName ?? 'Dispatch';
  const typeName = input.typeId ? await loadTypeName(input.typeId) : undefined;
  const subject = typeName
    ? `Confirm your subscription to ${typeName}`
    : `Confirm your subscription`;
  const greeting = input.name ? `Hi ${escapeHtml(input.name)},` : 'Hi,';
  const introHtml = typeName
    ? `Tap the button below to confirm your subscription to <strong>${escapeHtml(typeName)}</strong> from ${escapeHtml(senderName)}.`
    : `Tap the button below to confirm your subscription to ${escapeHtml(senderName)}.`;
  const introText = typeName
    ? `Tap the link below to confirm your subscription to ${typeName} from ${senderName}.`
    : `Tap the link below to confirm your subscription to ${senderName}.`;

  const html = `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f3f4f6;margin:0;padding:24px;color:#1f2937">
  <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:8px;padding:32px;border:1px solid #e5e7eb">
    <p style="font-size:15px;line-height:1.6;margin:0 0 12px">${greeting}</p>
    <p style="font-size:15px;line-height:1.6;margin:0 0 18px">${introHtml}</p>
    <p style="margin:18px 0">
      <a href="${escapeHtml(input.confirmUrl)}" style="display:inline-block;background:#9b3b21;color:#fff;text-decoration:none;padding:10px 18px;border-radius:5px;font-weight:600">Confirm subscription</a>
    </p>
    <p style="font-size:13px;line-height:1.6;color:#6b7280;margin:18px 0 0">If you didn't ask to subscribe, ignore this email — nothing will happen.</p>
    <p style="font-size:11px;line-height:1.6;color:#9ca3af;margin:24px 0 0;word-break:break-all">${escapeHtml(input.confirmUrl)}</p>
  </div></body></html>`;
  const text = `${greeting}\n\n${introText}\n\nConfirm: ${input.confirmUrl}\n\nIf you didn't ask to subscribe, ignore this email — nothing will happen.\n`;

  await ses.send(
    new SendEmailCommand({
      FromEmailAddress: FROM_ADDRESS,
      Destination: { ToAddresses: [input.email] },
      ConfigurationSetName: CONFIG_SET_NAME || undefined,
      Content: {
        Simple: {
          Subject: { Data: subject, Charset: 'UTF-8' },
          Body: {
            Html: { Data: html, Charset: 'UTF-8' },
            Text: { Data: text, Charset: 'UTF-8' },
          },
        },
      },
    }),
  );
}

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

async function loadTypeName(typeId: string): Promise<string | undefined> {
  const res = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: { PK: `TYPE#${typeId}`, SK: 'LATEST' } }),
  ).catch(() => null);
  return typeof res?.Item?.name === 'string' ? res.Item.name : undefined;
}

async function verifyTurnstile(token: string | undefined, ip: string | undefined): Promise<boolean> {
  // No secret configured → behave as if the captcha passed (dev / pre-rollout).
  // Production deploys should set TURNSTILE_SECRET so this path is exercised.
  if (!TURNSTILE_SECRET) return true;
  if (!token) return false;
  const params = new URLSearchParams();
  params.set('secret', TURNSTILE_SECRET);
  params.set('response', token);
  if (ip) params.set('remoteip', ip);
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: params,
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { success?: boolean };
    return data.success === true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(JSON.stringify({ level: 'error', msg: 'turnstile-fetch-failed', err: msg }));
    return false;
  }
}

function sourceIp(event: APIGatewayProxyEvent): string | undefined {
  return event.requestContext?.identity?.sourceIp;
}

function parseBody<T>(event: APIGatewayProxyEvent): T {
  if (!event.body) return {} as T;
  try {
    return JSON.parse(event.body) as T;
  } catch {
    throw new HttpError(400, 'invalid-json', 'Request body must be valid JSON');
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function redirect(location: string): APIGatewayProxyResult {
  return {
    statusCode: 302,
    headers: { Location: location, 'cache-control': 'no-store' },
    body: '',
  };
}

function ok(data: unknown): APIGatewayProxyResult {
  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: JSON.stringify(data),
  };
}

function errJson(status: number, code: string, message: string): APIGatewayProxyResult {
  return {
    statusCode: status,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ error: { code, message } }),
  };
}

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}
