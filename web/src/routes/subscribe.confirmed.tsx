import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { listPublicTypes } from '../api/endpoints';
import { config } from '../config';
import { PublicShell } from '../components/PublicShell';

export const Route = createFileRoute('/subscribe/confirmed')({
  component: SubscribeConfirmed,
  validateSearch: (search): { type?: string } => ({
    type: typeof search.type === 'string' ? search.type : undefined,
  }),
});

function SubscribeConfirmed() {
  const { type } = Route.useSearch();
  const typesQ = useQuery({
    queryKey: ['public-types'],
    queryFn: listPublicTypes,
    enabled: !!type,
  });
  const typeName = type
    ? typesQ.data?.items.find((t) => t.id === type)?.name
    : undefined;

  return (
    <PublicShell>
      <h1>You're subscribed</h1>
      <p>
        {typeName ? (
          <>
            Thanks — you're now on the list for{' '}
            <strong>{typeName}</strong> from {config.brand.full}.
          </>
        ) : (
          <>Thanks — you're now on the {config.brand.full} list.</>
        )}
      </p>
      <p className="muted">
        Every email we send includes a one-click unsubscribe link.
      </p>
    </PublicShell>
  );
}
