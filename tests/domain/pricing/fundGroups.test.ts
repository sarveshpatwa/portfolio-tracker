import { describe, expect, it } from 'vitest';
import { groupFunds, groupKey } from '../../../src/domain/pricing/fundGroups';
import type { Instrument, Portfolio, PortfolioAsset, PricePoint } from '../../../src/domain/types';

const inst = (id: string, name: string, fundId?: string, priceSource: Instrument['priceSource'] = 'manual'): Instrument => ({
  id, name, assetClass: 'fund', priceSource, currency: 'USD', createdAt: `t${id}`, updatedAt: 't',
  ...(fundId ? { priceLink: { url: '', fundId } } : {}),
});
const link = (instrumentId: string, portfolioId: string): PortfolioAsset => ({ id: `${instrumentId}-${portfolioId}`, portfolioId, instrumentId, addedAt: 't', updatedAt: 't' });
const pf = (id: string, name: string) => ({ id, name }) as Portfolio;

describe('groupFunds', () => {
  const portfolios = [pf('A', 'Growth'), pf('B', 'Retirement')];
  it('groups the same fund held in two portfolios (name match ignores case and spaces)', () => {
    const g = groupFunds([inst('1', 'Target 2050 Trust', 'N467'), inst('2', ' target  2050 trust ', 'N467')], [link('1', 'A'), link('2', 'B')], portfolios);
    expect(g).toHaveLength(1);
    expect(g[0]!.instrumentIds).toEqual(['1', '2']);
    expect(g[0]!.portfolioNames).toEqual(['Growth', 'Retirement']);
    expect(g[0]!.fundId).toBe('N467');
  });
  it('flags groups whose assets have different codes, and leaves market assets out', () => {
    const g = groupFunds([inst('1', 'X', 'N467'), inst('2', 'X'), inst('3', 'VTI', undefined, 'market')], [link('1', 'A'), link('2', 'B'), link('3', 'A')], portfolios);
    expect(g).toHaveLength(1);
    expect(g[0]!.fundId).toBe('mixed');
  });
  it('skips assets not held in any portfolio and picks the newest price', () => {
    const prices: PricePoint[] = [
      { instrumentId: '1', date: '2026-10-29', close: '10', source: 'manual' },
      { instrumentId: '2', date: '2026-10-30', close: '11', source: 'link' },
    ];
    const g = groupFunds([inst('1', 'F'), inst('2', 'F'), inst('9', 'Orphan')], [link('1', 'A'), link('2', 'B')], portfolios, prices);
    expect(g.map((x) => x.name)).toEqual(['F']);
    expect(g[0]!.latest?.date).toBe('2026-10-30');
    expect(g[0]!.latest?.source).toBe('link');
  });
  it('normalises keys', () => {
    expect(groupKey('  A   b ')).toBe('a b');
  });
});
