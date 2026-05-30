import type { APIGatewayProxyHandler, APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { FROM_LOCAL_PART_RE, FROM_NAME_MAX, REPLY_TO_RE } from '../../../packages/shared/src';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

const TABLE = mustEnv('TABLE_NAME');
const PK = 'ORG#default';
const SK = 'SETTINGS';
// Surface the sending domain in the read response so the Settings UI can
// render the static `@<domain>` suffix next to the local-part input. The
// admin Lambda doesn't itself send mail; this is purely informational.
const SENDING_DOMAIN = process.env.SENDING_DOMAIN ?? '';

const FOOTER_MAX = 20_000;
const ADDRESS_MAX = 500;
const NAME_MAX = 120;

export const handler: APIGatewayProxyHandler = async (event) => {
  try {
    const route = `${event.httpMethod} ${event.resource}`;
    switch (route) {
      case 'GET /admin/settings':
        return ok(await readSettings());
      case 'PUT /admin/settings':
        return ok(await writeSettings(parseBody(event), claimsOf(event)));
      default:
        return err(404, 'not-found', `No route for ${route}`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(JSON.stringify({ level: 'error', msg }));
    if (e instanceof HttpError) return err(e.status, e.code, e.message);
    return err(500, 'internal-error', 'Unexpected server error');
  }
};

interface SettingsInput {
  footerHtml?: string;
  senderName?: string;
  senderAddress?: string;
  fromName?: string;
  fromLocalPart?: string;
  replyTo?: string;
}

interface SettingsRecord {
  footerHtml: string;
  senderName?: string;
  senderAddress?: string;
  fromName?: string;
  fromLocalPart?: string;
  replyTo?: string;
  updatedAt?: string;
  updatedBy?: string;
}

/** Adds sendingDomain to the read response so the UI knows the domain
 *  the local-part will be appended to. Not persisted — it's an env value. */
type SettingsResponse = SettingsRecord & { sendingDomain: string };

async function readSettings(): Promise<SettingsResponse> {
  const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: { PK, SK } }));
  const base: SettingsRecord = res.Item
    ? (() => {
        const { PK: _pk, SK: _sk, ...rest } = res.Item as Record<string, unknown>;
        void _pk; void _sk;
        return rest as SettingsRecord;
      })()
    : { footerHtml: '' };
  return { ...base, sendingDomain: SENDING_DOMAIN };
}

async function writeSettings(body: SettingsInput, claims: Claims): Promise<SettingsResponse> {
  const footerHtml = (body.footerHtml ?? '').trim();
  const senderName = body.senderName?.trim() || undefined;
  const senderAddress = body.senderAddress?.trim() || undefined;
  const fromName = body.fromName?.trim() || undefined;
  const fromLocalPart = body.fromLocalPart?.trim().toLowerCase() || undefined;
  const replyTo = body.replyTo?.trim().toLowerCase() || undefined;

  if (footerHtml.length > FOOTER_MAX) {
    throw new HttpError(400, 'invalid-input', `footerHtml must be ≤ ${FOOTER_MAX} chars`);
  }
  if (senderName && senderName.length > NAME_MAX) {
    throw new HttpError(400, 'invalid-input', `senderName must be ≤ ${NAME_MAX} chars`);
  }
  if (senderAddress && senderAddress.length > ADDRESS_MAX) {
    throw new HttpError(400, 'invalid-input', `senderAddress must be ≤ ${ADDRESS_MAX} chars`);
  }
  if (fromName && fromName.length > FROM_NAME_MAX) {
    throw new HttpError(400, 'invalid-input', `fromName must be ≤ ${FROM_NAME_MAX} chars`);
  }
  if (fromLocalPart && !FROM_LOCAL_PART_RE.test(fromLocalPart)) {
    throw new HttpError(
      400,
      'invalid-input',
      'fromLocalPart must be lowercase letters, digits, dots, dashes, or underscores (≤ 64 chars)',
    );
  }
  if (replyTo && !REPLY_TO_RE.test(replyTo)) {
    throw new HttpError(400, 'invalid-input', `replyTo must be a valid email address`);
  }
  // Compliance: refuse to save a footer body without a physical address.
  // The worker relies on senderAddress always being present once anything is saved.
  if (footerHtml && !senderAddress) {
    throw new HttpError(
      400,
      'address-required',
      'A physical sender address is required (CAN-SPAM). Set Sender mailing address before saving footer content.',
    );
  }

  const record: SettingsRecord = {
    footerHtml,
    senderName,
    senderAddress,
    fromName,
    fromLocalPart,
    replyTo,
    updatedAt: new Date().toISOString(),
    updatedBy: claims.email ?? claims.sub,
  };

  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: { PK, SK, ...record },
    }),
  );
  return { ...record, sendingDomain: SENDING_DOMAIN };
}

function parseBody(event: APIGatewayProxyEvent): SettingsInput {
  if (!event.body) return {};
  try {
    return JSON.parse(event.body) as SettingsInput;
  } catch {
    throw new HttpError(400, 'invalid-json', 'Request body must be valid JSON');
  }
}

type Claims = { sub?: string; email?: string };
function claimsOf(event: APIGatewayProxyEvent): Claims {
  const c = (event.requestContext.authorizer?.claims ?? {}) as Record<string, string>;
  return { sub: c.sub, email: c.email };
}

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function ok(data: unknown): APIGatewayProxyResult {
  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(data),
  };
}

function err(status: number, code: string, message: string): APIGatewayProxyResult {
  return {
    statusCode: status,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ error: { code, message } }),
  };
}

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}
