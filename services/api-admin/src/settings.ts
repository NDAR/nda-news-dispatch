import type { APIGatewayProxyHandler, APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

const TABLE = mustEnv('TABLE_NAME');
const PK = 'ORG#default';
const SK = 'SETTINGS';

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
}

interface SettingsRecord {
  footerHtml: string;
  senderName?: string;
  senderAddress?: string;
  updatedAt?: string;
  updatedBy?: string;
}

async function readSettings(): Promise<SettingsRecord> {
  const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: { PK, SK } }));
  if (!res.Item) {
    return { footerHtml: '' };
  }
  const { PK: _pk, SK: _sk, ...rest } = res.Item as Record<string, unknown>;
  void _pk; void _sk;
  return rest as SettingsRecord;
}

async function writeSettings(body: SettingsInput, claims: Claims): Promise<SettingsRecord> {
  const footerHtml = (body.footerHtml ?? '').trim();
  const senderName = body.senderName?.trim() || undefined;
  const senderAddress = body.senderAddress?.trim() || undefined;

  if (footerHtml.length > FOOTER_MAX) {
    throw new HttpError(400, 'invalid-input', `footerHtml must be ≤ ${FOOTER_MAX} chars`);
  }
  if (senderName && senderName.length > NAME_MAX) {
    throw new HttpError(400, 'invalid-input', `senderName must be ≤ ${NAME_MAX} chars`);
  }
  if (senderAddress && senderAddress.length > ADDRESS_MAX) {
    throw new HttpError(400, 'invalid-input', `senderAddress must be ≤ ${ADDRESS_MAX} chars`);
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
    updatedAt: new Date().toISOString(),
    updatedBy: claims.email ?? claims.sub,
  };

  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: { PK, SK, ...record },
    }),
  );
  return record;
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
