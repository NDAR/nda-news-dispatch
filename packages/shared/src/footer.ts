export interface OrgSettings {
  footerHtml: string;
  senderName?: string;
  senderAddress?: string;
  /** Org-wide From display name (e.g. "Newsletter"). Resolved via
   *  resolveSender(); footer rendering ignores this field. */
  fromName?: string;
  /** Org-wide From local-part. Combined with the deploy-time sending
   *  domain to form the full From address. */
  fromLocalPart?: string;
  /** Org-wide Reply-To email. Any domain — no SES verification required
   *  for Reply-To. */
  replyTo?: string;
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
    `<tr><td>${nameLine}${addressLine}<a ses:no-track href="${escapeAttr(unsubUrl)}" style="color:#6b7280;text-decoration:underline;">Unsubscribe</a></td></tr>`,
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

/** A small bar inserted at the very top of the email body inviting the
 *  recipient to view the message in their browser. Inline-styled for
 *  email-client compatibility. */
export function renderViewInBrowserBar(viewUrl: string): string {
  return [
    '<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;font-size:12px;color:#6b7280;text-align:center;padding:12px 16px;background:#f9fafb;border-bottom:1px solid #e5e7eb;">',
    `Trouble viewing this email? <a ses:no-track href="${escapeAttr(viewUrl)}" style="color:#6b7280;text-decoration:underline;">View it in your browser</a>.`,
    '</div>',
  ].join('');
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
