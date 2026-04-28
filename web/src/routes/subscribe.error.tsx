import { createFileRoute, Link } from '@tanstack/react-router';
import { PublicShell } from '../components/PublicShell';

export const Route = createFileRoute('/subscribe/error')({
  component: SubscribeError,
  validateSearch: (search): { reason?: string } => ({
    reason: typeof search.reason === 'string' ? search.reason : undefined,
  }),
});

function SubscribeError() {
  const { reason } = Route.useSearch();
  const expired = reason === 'expired';
  return (
    <PublicShell>
      <h1>{expired ? 'Link expired' : 'Something went wrong'}</h1>
      <p>
        {expired
          ? 'Confirmation links expire after 48 hours. Re-submit the form below to get a fresh one.'
          : 'We couldn\'t verify that confirmation link. Try the form again.'}
      </p>
      <p>
        <Link to="/subscribe" className="btn">Back to subscribe</Link>
      </p>
    </PublicShell>
  );
}
