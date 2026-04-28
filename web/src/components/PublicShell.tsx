import type { ReactNode } from 'react';

/**
 * Wrapper for the unauthenticated public pages (subscribe form, pending,
 * confirmed, error). Inlines its CSS so the SPA's authed bundle stays out
 * of these views.
 */
export function PublicShell({ children }: { children: ReactNode }) {
  return (
    <div className="public-shell">
      <style>{PUBLIC_CSS}</style>
      <div className="card">{children}</div>
    </div>
  );
}

const PUBLIC_CSS = `
  body{margin:0}
  .public-shell{
    min-height:100vh;background:#faf7f1;color:#2a2420;
    font-family:'Source Serif 4',Georgia,serif;
    display:grid;place-items:center;padding:32px 16px;
  }
  .public-shell .card{
    max-width:480px;width:100%;background:#fff;border:1px solid #e6decf;
    border-radius:8px;padding:36px 32px;box-shadow:0 1px 2px rgba(0,0,0,.04);
  }
  .public-shell h1{font-size:24px;margin:0 0 12px;letter-spacing:-.01em}
  .public-shell p{font-size:15px;line-height:1.6;color:#554a40;margin:8px 0}
  .public-shell p.lede{margin-bottom:18px}
  .public-shell strong{color:#2a2420}
  .public-shell em{color:#8a7f70;font-style:normal;font-size:13px}
  .public-shell p.muted{color:#8a7f70;font-size:13px;margin-top:14px}
  .public-shell p.err{color:#9b3b21;font-size:13px;margin-top:8px}
  .public-shell .form{display:flex;flex-direction:column;gap:14px;margin-top:18px}
  .public-shell label{display:flex;flex-direction:column;gap:4px;font-size:13px;color:#554a40}
  .public-shell input,.public-shell select{
    font:inherit;font-size:15px;color:#2a2420;background:#faf7f1;
    border:1px solid #e6decf;border-radius:5px;padding:8px 10px;
  }
  .public-shell input:focus,.public-shell select:focus{outline:none;border-color:#9b3b21}
  .public-shell .btn{
    font:inherit;font-size:15px;background:#9b3b21;color:#fff;
    border:none;border-radius:5px;padding:10px 18px;cursor:pointer;font-weight:600;
    text-decoration:none;display:inline-block;
  }
  .public-shell .btn:hover{background:#7a2d18}
  .public-shell .btn:disabled{opacity:.6;cursor:not-allowed}
  .public-shell .turnstile{margin-top:4px}
  .public-shell .honeypot{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}
  .public-shell code{
    font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:#f4efe5;
    padding:2px 6px;border-radius:3px;font-size:13px;
  }
`;
