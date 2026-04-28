import { createFileRoute } from '@tanstack/react-router';
import { PublicShell } from '../components/PublicShell';

export const Route = createFileRoute('/subscribe/pending')({
  component: SubscribePending,
  validateSearch: (search): { email?: string } => ({
    email: typeof search.email === 'string' ? search.email : undefined,
  }),
});

function SubscribePending() {
  const { email } = Route.useSearch();
  return (
    <PublicShell>
      <h1>Check your inbox</h1>
      <p>
        We just sent {email ? <code>{email}</code> : 'you'} a confirmation
        email. Click the link inside to finish subscribing.
      </p>
      <p className="muted">
        If it doesn't show up in a minute or two, check your spam folder. The
        link expires in 48 hours — re-submit the form to get a new one.
      </p>
    </PublicShell>
  );
}
