import { useRouterState } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { listTemplates, previewAudience } from '../api/endpoints';

interface Title {
  eyebrow: string;
  title: string;
  sub: string;
}

const STATIC_TITLES: Record<string, Title> = {
  '/compose': { eyebrow: 'Workspace', title: 'Compose', sub: 'newsletters in progress' },
  '/types': { eyebrow: 'Workspace', title: 'Types', sub: 'Define newsletter categories' },
  '/subscribers': { eyebrow: 'Audience', title: 'Subscribers', sub: 'on the list' },
  '/send': { eyebrow: 'Delivery', title: 'Send', sub: 'Review and deliver your dispatch' },
  '/history': { eyebrow: 'Archive', title: 'History', sub: 'Past sends and engagement' },
  '/settings': { eyebrow: 'Workspace', title: 'Settings', sub: 'Footer + sender info applied to every email' },
  '/help': { eyebrow: 'Workspace', title: 'Help', sub: 'How to use Dispatch' },
};

export function TopBar() {
  const { location } = useRouterState();
  const path = location.pathname;

  // Match the longest static prefix so /history/$id still resolves to History.
  const matchKey = Object.keys(STATIC_TITLES)
    .filter((k) => path === k || path.startsWith(`${k}/`))
    .sort((a, b) => b.length - a.length)[0];
  const base = matchKey ? STATIC_TITLES[matchKey] : null;

  // Dynamic subtext for the two pages that had counts in the original design.
  // queryKey ['templates'] is shared with the compose page, so this is free
  // when the user has visited Compose; otherwise it costs one API call.
  const templatesQ = useQuery({
    queryKey: ['templates'],
    queryFn: listTemplates,
    enabled: matchKey === '/compose',
    staleTime: 60_000,
  });
  const audienceQ = useQuery({
    queryKey: ['audience-preview', 'all-active'],
    queryFn: () => previewAudience({ tags: [], excludeTags: [], tagMode: 'all' }),
    enabled: matchKey === '/subscribers',
    staleTime: 60_000,
  });

  if (!base) return null;

  let sub = base.sub;
  if (matchKey === '/compose' && templatesQ.data) {
    const n = templatesQ.data.length;
    sub = `${n.toLocaleString()} newsletter${n === 1 ? '' : 's'} in progress`;
  } else if (matchKey === '/subscribers' && audienceQ.data) {
    const n = audienceQ.data.total ?? audienceQ.data.count ?? 0;
    sub = `${n.toLocaleString()} on the list`;
  } else if (matchKey === '/history' && path !== '/history') {
    sub = 'Campaign detail';
  } else if (matchKey === '/types' && path !== '/types' && path !== '/types/') {
    sub = path.endsWith('/new') ? 'New type' : 'Edit type';
  }

  return (
    <div className="topbar">
      <div className="topbar-title">
        <span className="eyebrow">{base.eyebrow}</span>
        <h2 className="serif">
          {base.title}{' '}
          <span
            className="muted"
            style={{ fontSize: 15, fontStyle: 'italic', marginLeft: 6 }}
          >
            — {sub}
          </span>
        </h2>
      </div>
    </div>
  );
}
