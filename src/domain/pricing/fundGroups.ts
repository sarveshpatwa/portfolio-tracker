/**
 * One-time price-link setup across portfolios.
 *
 * Manual assets are separate records per portfolio, so the same Vanguard fund
 * held in two portfolios is two assets. For setup they're grouped by name
 * (case- and space-insensitive): one fund code entered once applies to every
 * asset in the group.
 */

import { priceOnOrBefore, type DatedPrice } from './prices';
import type { Id, Instrument, Portfolio, PortfolioAsset, PricePoint } from '../types';

export interface FundGroup {
  key: string;
  name: string;
  instrumentIds: Id[];
  portfolioNames: string[];
  /** The common fund code; undefined when none is set; 'mixed' when the assets disagree. */
  fundId: string | undefined | 'mixed';
  /** A link URL from any asset in the group (for "Open page"). */
  url: string;
  /** Newest price of the group (all assets in a group get the same fetched prices). */
  latest?: DatedPrice;
}

export const groupKey = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();

export function groupFunds(
  instruments: readonly Instrument[],
  links: readonly PortfolioAsset[],
  portfolios: readonly Portfolio[],
  prices: readonly PricePoint[] = [],
): FundGroup[] {
  const portfolioName = new Map(portfolios.map((p) => [p.id, p.name]));
  const groups = new Map<string, FundGroup>();
  // Oldest first, so a group is named after the first-added copy.
  const ordered = [...instruments].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const inst of ordered) {
    if (inst.priceSource !== 'manual') continue;
    const held = links.filter((l) => l.instrumentId === inst.id);
    if (held.length === 0) continue;
    const key = groupKey(inst.name);
    let g = groups.get(key);
    if (!g) {
      g = { key, name: inst.name, instrumentIds: [], portfolioNames: [], fundId: inst.priceLink?.fundId, url: '' };
      groups.set(key, g);
    } else if (g.fundId !== inst.priceLink?.fundId) {
      g.fundId = 'mixed';
    }
    g.instrumentIds.push(inst.id);
    if (!g.url && inst.priceLink?.url) g.url = inst.priceLink.url;
    for (const l of held) {
      const n = portfolioName.get(l.portfolioId);
      if (n && !g.portfolioNames.includes(n)) g.portfolioNames.push(n);
    }
    const latest = priceOnOrBefore(prices.filter((p) => p.instrumentId === inst.id));
    if (latest && (!g.latest || latest.date > g.latest.date)) g.latest = latest;
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
}
