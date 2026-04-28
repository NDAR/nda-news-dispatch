import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { config } from '../config';
import { listPublicTypes, submitSubscribe } from '../api/endpoints';
import { PublicShell } from '../components/PublicShell';

export const Route = createFileRoute('/subscribe/')({
  component: SubscribePage,
  validateSearch: (search): { type?: string } => ({
    type: typeof search.type === 'string' ? search.type : undefined,
  }),
});

declare global {
  interface Window {
    turnstile?: {
      render: (
        target: HTMLElement,
        opts: {
          sitekey: string;
          callback: (token: string) => void;
          'error-callback'?: () => void;
          'expired-callback'?: () => void;
          theme?: 'auto' | 'light' | 'dark';
          appearance?: 'always' | 'execute' | 'interaction-only';
        },
      ) => string;
      reset: (widgetId?: string) => void;
    };
  }
}

function SubscribePage() {
  const navigate = useNavigate();
  const { type: presetType } = Route.useSearch();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [typeId, setTypeId] = useState<string>(presetType ?? '');
  const [hp, setHp] = useState(''); // honeypot
  const [turnstileToken, setTurnstileToken] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const turnstileRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);

  const typesQ = useQuery({
    queryKey: ['public-types'],
    queryFn: listPublicTypes,
  });
  const types = typesQ.data?.items ?? [];

  // Lock the type field when it was preset via the URL — that's the per-type
  // "subscribe to *this* newsletter" link case. Without a preset, show the
  // chooser only if there's more than one subscribable type. With exactly
  // one option, silently auto-select it instead of showing a single-item
  // dropdown.
  const typeLocked = !!presetType;
  useEffect(() => {
    if (typeLocked) return;
    if (types.length === 1 && !typeId) setTypeId(types[0].id);
  }, [typeLocked, types, typeId]);
  const showTypeChooser = !typeLocked && types.length > 1;

  // Load Turnstile script + render the widget when a site key is configured.
  useEffect(() => {
    if (!config.turnstileSiteKey) return;
    if (document.querySelector('script[data-turnstile]')) return;
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
    s.async = true;
    s.defer = true;
    s.dataset.turnstile = '1';
    document.head.appendChild(s);
  }, []);

  useEffect(() => {
    if (!config.turnstileSiteKey) return;
    const el = turnstileRef.current;
    if (!el) return;
    let cancelled = false;
    const tryRender = () => {
      if (cancelled) return;
      if (!window.turnstile) {
        setTimeout(tryRender, 200);
        return;
      }
      if (widgetIdRef.current) return;
      widgetIdRef.current = window.turnstile.render(el, {
        sitekey: config.turnstileSiteKey,
        callback: (token) => setTurnstileToken(token),
        'expired-callback': () => setTurnstileToken(''),
        'error-callback': () => setTurnstileToken(''),
      });
    };
    tryRender();
    return () => {
      cancelled = true;
    };
  }, []);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (config.turnstileSiteKey && !turnstileToken) {
      setError('Please complete the captcha.');
      return;
    }
    setSubmitting(true);
    try {
      await submitSubscribe({
        email: email.trim(),
        name: name.trim() || undefined,
        typeId: typeId || undefined,
        website: hp,
        turnstileToken: turnstileToken || undefined,
      });
      navigate({
        to: '/subscribe/pending',
        search: { email: email.trim() },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Something went wrong. Please try again.';
      setError(msg);
      // Reset Turnstile so the user can re-challenge.
      if (window.turnstile && widgetIdRef.current) {
        window.turnstile.reset(widgetIdRef.current);
        setTurnstileToken('');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const presetTypeName = presetType
    ? types.find((t) => t.id === presetType)?.name ?? null
    : null;

  // Single-type case: show the type name in the lede so the visitor knows
  // exactly what they're signing up for, even though the dropdown is hidden.
  const soloTypeName = !typeLocked && types.length === 1 ? types[0].name : null;

  // No subscribable types at all and no preset → there's nothing to sign up
  // for. Render a friendly note instead of an empty form.
  if (!presetType && !typesQ.isLoading && types.length === 0) {
    return (
      <PublicShell>
        <h1>Subscribe to {config.brand.full}</h1>
        <p>Public sign-ups are currently closed. Check back later.</p>
      </PublicShell>
    );
  }

  return (
    <PublicShell>
      <h1>Subscribe to {config.brand.full}</h1>
      {presetTypeName && (
        <p className="lede">
          You're signing up for <strong>{presetTypeName}</strong>.
        </p>
      )}
      {!presetTypeName && soloTypeName && (
        <p className="lede">
          You're signing up for <strong>{soloTypeName}</strong>.
        </p>
      )}
      <form onSubmit={onSubmit} className="form">
        <label>
          <span>Email</span>
          <input
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
          />
        </label>
        <label>
          <span>Name <em>(optional)</em></span>
          <input
            type="text"
            autoComplete="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your name"
          />
        </label>

        {showTypeChooser && (
          <label>
            <span>Newsletter</span>
            <select value={typeId} onChange={(e) => setTypeId(e.target.value)}>
              <option value="">Choose a newsletter…</option>
              {types.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </label>
        )}

        {/* Honeypot — visually hidden but reachable by bots that auto-fill. */}
        <div className="honeypot" aria-hidden="true">
          <label>
            Website
            <input
              type="text"
              tabIndex={-1}
              autoComplete="off"
              value={hp}
              onChange={(e) => setHp(e.target.value)}
            />
          </label>
        </div>

        {config.turnstileSiteKey && <div ref={turnstileRef} className="turnstile" />}

        {error && <p className="err">{error}</p>}

        <button type="submit" className="btn" disabled={submitting}>
          {submitting ? 'Subscribing…' : 'Subscribe'}
        </button>
        <p className="muted">
          We'll send you a confirmation email. You can unsubscribe at any time
          from a link in every newsletter.
        </p>
      </form>
    </PublicShell>
  );
}

