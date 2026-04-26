/** Mirrors `services/worker-send/src/footer.ts`'s `renderFooterHtml` so the
 *  SPA can show users exactly what their email will look like at send time. */
export function renderFooterPreviewHtml(input: {
  footerHtml: string;
  senderName?: string;
  senderAddress?: string;
  unsubUrl: string;
}): string {
  const { footerHtml, senderName, senderAddress, unsubUrl } = input;
  const body = footerHtml.trim()
    ? `<tr><td style="padding-bottom:12px;">${footerHtml}</td></tr>`
    : '';
  const nameLine = senderName?.trim()
    ? `<strong style="color:#374151;">${escapeHtml(senderName.trim())}</strong><br/>`
    : '';
  const addressLine = senderAddress?.trim()
    ? `${escapeHtml(senderAddress.trim()).replace(/\n/g, '<br/>')}<br/>`
    : '';
  return [
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:32px;border-top:1px solid #e5e7eb;padding-top:20px;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;font-size:12px;color:#6b7280;line-height:1.5;">',
    body,
    `<tr><td>${nameLine}${addressLine}<a href="${escapeAttr(unsubUrl)}" style="color:#6b7280;text-decoration:underline;">Unsubscribe</a></td></tr>`,
    '</table>',
  ].join('');
}

export function escapeHtml(s: string): string {
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
