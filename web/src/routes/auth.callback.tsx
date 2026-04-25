import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { handleCallback } from '../auth/cognito';

export const Route = createFileRoute('/auth/callback')({
  component: CallbackPage,
});

function CallbackPage() {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        await handleCallback();
        navigate({ to: '/compose', replace: true });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [navigate]);

  return (
    <div style={{ padding: 24, fontFamily: 'var(--serif)' }}>
      {error ? (
        <>
          <h2>Sign-in failed</h2>
          <p style={{ color: 'var(--ink-mute)' }}>{error}</p>
        </>
      ) : (
        <p className="muted">Finishing sign-in…</p>
      )}
    </div>
  );
}
