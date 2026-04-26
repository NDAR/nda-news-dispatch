const PREVIEW_CSP =
  "default-src 'none'; script-src 'none'; connect-src 'none'; form-action 'none'; frame-ancestors 'none'; style-src 'unsafe-inline'; img-src data: https: http:; font-src data: https: http:";

export function buildPreviewSrcDoc(html: string, opts: { baseHref?: string } = {}): string {
  const baseTag = opts.baseHref ? `<base href="${escapeAttr(opts.baseHref)}">` : '';
  const cspTag = `<meta http-equiv="Content-Security-Policy" content="${escapeAttr(PREVIEW_CSP)}">`;
  let doc = html.trim() || '<!doctype html><html><body></body></html>';

  if (!/<html[\s>]/i.test(doc)) {
    doc = `<!doctype html><html><body>${doc}</body></html>`;
  }
  if (/<head[\s>]/i.test(doc)) {
    doc = doc.replace(/<head([^>]*)>/i, `<head$1><meta charset="utf-8">${cspTag}${baseTag}`);
  } else {
    doc = doc.replace(
      /<html([^>]*)>/i,
      `<html$1><head><meta charset="utf-8">${cspTag}${baseTag}</head>`,
    );
  }
  return doc;
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
