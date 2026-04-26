import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

export interface OrgSettings {
  footerHtml: string;
  senderName?: string;
  senderAddress?: string;
}

const SETTINGS_TTL_MS = 60_000;
let cached: { at: number; settings: OrgSettings } | null = null;

export async function loadSettings(tableName: string): Promise<OrgSettings> {
  const now = Date.now();
  if (cached && now - cached.at < SETTINGS_TTL_MS) return cached.settings;
  const res = await ddb.send(
    new GetCommand({ TableName: tableName, Key: { PK: 'ORG#default', SK: 'SETTINGS' } }),
  );
  const settings: OrgSettings = res.Item
    ? {
        footerHtml: typeof res.Item.footerHtml === 'string' ? res.Item.footerHtml : '',
        senderName: typeof res.Item.senderName === 'string' ? res.Item.senderName : undefined,
        senderAddress:
          typeof res.Item.senderAddress === 'string' ? res.Item.senderAddress : undefined,
      }
    : { footerHtml: '' };
  cached = { at: now, settings };
  return settings;
}

/** Render the standard footer block. Always emits the unsubscribe + address row,
 *  even when settings.footerHtml is empty, so compliance is structural. */
export function renderFooterHtml(settings: OrgSettings, unsubUrl: string): string {
  const body = settings.footerHtml?.trim()
    ? `<tr><td style="padding-bottom:12px;">${settings.footerHtml}</td></tr>`
    : '';
  const nameLine = settings.senderName
    ? `<strong style="color:#374151;">${escapeHtml(settings.senderName)}</strong><br/>`
    : '';
  const addressLine = settings.senderAddress
    ? `${escapeHtml(settings.senderAddress).replace(/\n/g, '<br/>')}<br/>`
    : '';
  return [
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:32px;border-top:1px solid #e5e7eb;padding-top:20px;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;font-size:12px;color:#6b7280;line-height:1.5;">',
    body,
    `<tr><td>${nameLine}${addressLine}<a href="${escapeAttr(unsubUrl)}" style="color:#6b7280;text-decoration:underline;">Unsubscribe</a></td></tr>`,
    '</table>',
  ].join('');
}

export function renderFooterText(settings: OrgSettings, unsubUrl: string): string {
  const lines: string[] = ['', '--'];
  if (settings.senderName) lines.push(settings.senderName);
  if (settings.senderAddress) lines.push(settings.senderAddress);
  lines.push(`Unsubscribe: ${unsubUrl}`);
  return lines.join('\n');
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}
