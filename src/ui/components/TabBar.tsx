export type Tab = 'portfolios' | 'compare' | 'settings';

const TABS: { id: Tab; label: string }[] = [
  { id: 'portfolios', label: 'Portfolios' },
  { id: 'compare', label: 'Compare' },
  { id: 'settings', label: 'Settings' },
];

export function TabBar({ current }: { current: Tab }) {
  return (
    <nav className="tabbar" aria-label="Main">
      {TABS.map((t) => (
        <a key={t.id} href={`#/${t.id}`} className="tabbar-link" aria-current={t.id === current ? 'page' : undefined}>
          {t.label}
        </a>
      ))}
    </nav>
  );
}
