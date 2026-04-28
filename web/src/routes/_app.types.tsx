import {
  createFileRoute,
  Outlet,
  useNavigate,
  useRouterState,
} from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { archiveType, listTypes } from '../api/endpoints';
import { TypePill, TypeSwatch } from '../components/types/TypePill';

export const Route = createFileRoute('/_app/types')({
  component: TypesPage,
});

function TypesPage() {
  // Child routes (`_app.types.$typeId.tsx`) nest under this one — render the
  // Outlet for /types/<id> so the edit page mounts; otherwise show the list.
  const { location } = useRouterState();
  if (location.pathname !== '/types' && location.pathname !== '/types/') {
    return <Outlet />;
  }
  return <TypesList />;
}

function TypesList() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [showArchived, setShowArchived] = useState(false);

  const { data: types = [], isLoading, error } = useQuery({
    queryKey: ['types', showArchived],
    queryFn: () => listTypes(showArchived),
  });

  const archiveMut = useMutation({
    mutationFn: (id: string) => archiveType(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['types'] }),
  });

  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="card">
        <div className="card-header">
          <div>
            <div className="eyebrow">Workspace</div>
            <h3 className="serif mt-sm">Newsletter types</h3>
          </div>
          <div className="row items-center gap-md">
            <label className="row items-center gap-sm" style={{ fontSize: 12, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={showArchived}
                onChange={(e) => setShowArchived(e.target.checked)}
              />
              Show archived
            </label>
            <button
              className="btn btn-primary btn-sm"
              onClick={() => navigate({ to: '/types/$typeId', params: { typeId: 'new' } })}
            >
              + New type
            </button>
          </div>
        </div>
        <div className="card-body" style={{ padding: 0 }}>
          {isLoading && <p className="muted" style={{ padding: 16 }}>Loading…</p>}
          {error && (
            <p style={{ color: 'var(--bad)', padding: 16 }}>
              Failed to load types: {(error as Error).message}
            </p>
          )}
          {!isLoading && types.length === 0 && (
            <div className="muted" style={{ padding: 24, textAlign: 'center' }}>
              No types yet. Create one to start composing newsletters.
            </div>
          )}
          {types.map((t) => (
            <div
              key={t.id}
              style={{
                padding: '14px 20px',
                borderBottom: '1px solid var(--rule-soft)',
                opacity: t.archived ? 0.55 : 1,
              }}
            >
              <div className="row items-center justify-between" style={{ gap: 16 }}>
                <div className="row items-center gap-md" style={{ flex: 1, minWidth: 0 }}>
                  <TypeSwatch hue={t.color} size={18} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="row items-center gap-sm">
                      <span className="serif" style={{ fontSize: 16 }}>{t.name}</span>
                      <TypePill type={t} />
                      {t.publicSubscribable && (
                        <span
                          title="Visitors can self-subscribe to this type via the public /subscribe page"
                          style={{
                            fontSize: 10,
                            padding: '2px 8px',
                            borderRadius: 999,
                            background: 'oklch(95% 0.05 145)',
                            color: 'oklch(35% 0.1 145)',
                            fontWeight: 600,
                            letterSpacing: 0.2,
                          }}
                        >
                          Public sign-up
                        </span>
                      )}
                      {t.defaultBodyHtml && (
                        <span
                          className="mono-sm muted"
                          title="This type seeds new newsletters with a default HTML body"
                          style={{ fontSize: 10 }}
                        >
                          · template
                        </span>
                      )}
                    </div>
                    {t.description && (
                      <div className="muted" style={{ fontSize: 12, marginTop: 3 }}>{t.description}</div>
                    )}
                    <div className="row items-center" style={{ gap: 6, flexWrap: 'wrap', marginTop: 6, fontSize: 11 }}>
                      {t.defaultSubjectPrefix && (
                        <span className="mono-sm muted">prefix: <code>{t.defaultSubjectPrefix}</code></span>
                      )}
                      {t.defaultTags.length > 0 && (
                        <span className="mono-sm muted">
                          tags: {t.defaultTags.map((tag) => `#${tag}`).join(' ')}
                        </span>
                      )}
                      {t.defaultTags.length === 0 && !t.defaultSubjectPrefix && !t.defaultBodyHtml && (
                        <span className="faint" style={{ fontSize: 11 }}>no defaults</span>
                      )}
                    </div>
                  </div>
                </div>
                <div className="row gap-sm">
                  <button
                    className="btn btn-sm"
                    onClick={() => navigate({ to: '/types/$typeId', params: { typeId: t.id } })}
                  >
                    Edit
                  </button>
                  {!t.archived && (
                    <button
                      className="btn btn-sm"
                      style={{ color: 'var(--bad)' }}
                      onClick={() => {
                        if (confirm(`Archive "${t.name}"? Existing newsletters keep their reference; new ones can no longer use it.`)) {
                          archiveMut.mutate(t.id);
                        }
                      }}
                    >
                      Archive
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
