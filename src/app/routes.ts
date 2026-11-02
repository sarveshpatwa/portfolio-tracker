/**
 * Hash-based routes (#/p/<id>). Hash routing works on any static host,
 * including GitHub Pages, without server configuration, and survives reloads
 * and the iPhone home-screen app being reopened.
 */

export type Route =
  | { name: 'portfolios' }
  | { name: 'portfolio'; id: string }
  | { name: 'add-asset'; id: string }
  | { name: 'money'; id: string }
  | { name: 'ledger'; id: string }
  | { name: 'compare' }
  | { name: 'settings' };

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  const [first, id, sub] = parts;
  if (first === 'p' && id) {
    if (sub === 'add-asset' || sub === 'money' || sub === 'ledger') return { name: sub, id };
    return { name: 'portfolio', id };
  }
  if (first === 'compare') return { name: 'compare' };
  if (first === 'settings') return { name: 'settings' };
  return { name: 'portfolios' };
}

export const href = {
  portfolios: () => '#/portfolios',
  portfolio: (id: string) => `#/p/${encodeURIComponent(id)}`,
  addAsset: (id: string) => `#/p/${encodeURIComponent(id)}/add-asset`,
  money: (id: string) => `#/p/${encodeURIComponent(id)}/money`,
  ledger: (id: string) => `#/p/${encodeURIComponent(id)}/ledger`,
  compare: () => '#/compare',
  settings: () => '#/settings',
};

export function navigate(to: string): void {
  location.hash = to;
}
