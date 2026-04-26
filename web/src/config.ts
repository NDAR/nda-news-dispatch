/**
 * Runtime config. In production the SPA is served by the same CloudFront
 * distribution that fronts the API, so API_BASE='' → fetches go to '/admin/...'
 * (same origin, no CORS). In local dev we point directly at API Gateway.
 */
function must(name: string, value: string | undefined): string {
  if (!value) throw new Error(`Missing build-time env var ${name} — see .env.example`);
  return value;
}

// The brand prefix shown before "Dispatch" everywhere in the UI (sidebar,
// browser title, favicon initial). "Dispatch" is fixed; only the prefix is
// configurable via build-time `VITE_APP_BRAND` (.env.production / shell var).
const APP_BRAND = (import.meta.env.VITE_APP_BRAND ?? 'Ants').trim() || 'Ants';

export const config = {
  apiBase: import.meta.env.VITE_API_BASE ?? '',
  brand: {
    prefix: APP_BRAND,
    full: `${APP_BRAND} Dispatch`,
  },
  cognito: {
    domain: must('VITE_COGNITO_DOMAIN', import.meta.env.VITE_COGNITO_DOMAIN),
    clientId: must('VITE_COGNITO_CLIENT_ID', import.meta.env.VITE_COGNITO_CLIENT_ID),
    region: import.meta.env.VITE_COGNITO_REGION ?? 'us-east-1',
    redirectUri: must('VITE_REDIRECT_URI', import.meta.env.VITE_REDIRECT_URI),
    scopes: ['openid', 'email', 'profile'],
  },
};
