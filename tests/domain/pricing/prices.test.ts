import { describe, expect, it } from 'vitest';
import { d } from '../../../src/domain/money/decimal';
import { describeAge, manualPriceStatus, priceMap, priceOnOrBefore, pricesOnOrBefore } from '../../../src/domain/pricing/prices';
import { replayLedger } from '../../../src/domain/portfolio/ledger';
import { valuePortfolio } from '../../../src/domain/portfolio/valuation';
import { breakdownByClass } from '../../../src/domain/portfolio/breakdown';
import type { AssetClass, PricePoint } from '../../../src/domain/types';
import { buy, tx } from '../../helpers';

const pt = (instrumentId: string, date: string, close: string, source: PricePoint['source'] = 'manual'): PricePoint => ({
  instrumentId,
  date,
  close,
  source,
});

const points = [
  pt('FUNDA', '2026-10-03', '18.50'),
  pt('FUNDA', '2026-10-17', '18.80'),
  pt('FUNDA', '2026-09-19', '18.20'),
  pt('BND', '2026-10-29', '73.00', 'market'),
];

describe('priceOnOrBefore', () => {
  it('uses the latest point on or before the date (held flat between updates)', () => {
    const funda = points.filter((p) => p.instrumentId === 'FUNDA');
    expect(priceOnOrBefore(funda)?.price.toString()).toBe('18.8');
    expect(priceOnOrBefore(funda, '2026-10-16')?.price.toString()).toBe('18.5');
    expect(priceOnOrBefore(funda, '2026-10-03')?.date).toBe('2026-10-03');
    expect(priceOnOrBefore(funda, '2026-09-01')).toBeUndefined();
  });

  it('builds a price map across instruments', () => {
    const m = pricesOnOrBefore(points, '2026-10-20');
    expect(m.get('FUNDA')?.price.toString()).toBe('18.8');
    expect(m.has('BND')).toBe(false);
    expect(priceMap(pricesOnOrBefore(points)).get('BND')?.toString()).toBe('73');
  });
});

describe('manualPriceStatus', () => {
  it('flags a price update when the reminder interval has passed', () => {
    expect(manualPriceStatus('2026-10-17', '2026-10-23', 14)).toEqual({ ageDays: 6, updateDue: false });
    expect(manualPriceStatus('2026-10-17', '2026-10-31', 14)).toEqual({ ageDays: 14, updateDue: true });
    expect(manualPriceStatus('2026-10-17', '2026-12-31')).toEqual({ ageDays: 75, updateDue: false });
  });

  it('describes ages in plain words', () => {
    expect(describeAge(0)).toBe('today');
    expect(describeAge(1)).toBe('yesterday');
    expect(describeAge(6)).toBe('6 days ago');
    expect(describeAge(21)).toBe('3 weeks ago');
    expect(describeAge(75)).toBe('2 months ago');
  });
});

describe('breakdownByClass', () => {
  it('sums holdings per asset class with cash as its own row', () => {
    const state = replayLedger([
      tx('DEPOSIT', '2026-01-05', { amount: '1000' }),
      buy('2026-01-05', 'VTI', '2', '200'),
      buy('2026-01-05', 'VXUS', '4', '50'),
      buy('2026-01-05', 'BND', '5', '70'),
    ]);
    const v = valuePortfolio(state, new Map([['VTI', d('200')], ['VXUS', d('50')], ['BND', d('70')]]));
    const classes: Record<string, AssetClass> = { VTI: 'etf', VXUS: 'etf', BND: 'bond' };
    const slices = breakdownByClass(v, (id) => classes[id] ?? 'other');
    expect(slices.map((s) => [s.key, s.value.toString(), s.weight.toFixed(2)])).toEqual([
      ['etf', '600', '0.60'],
      ['bond', '350', '0.35'],
      ['cash', '50', '0.05'],
    ]);
  });
});
