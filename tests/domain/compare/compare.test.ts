import { describe, expect, it } from 'vitest';
import { metricsOf, RISK_FREE_RATE } from '../../../src/domain/compare/metrics';
import { periodStart, runBacktest, type Mix } from '../../../src/domain/compare/backtest';
import { baselineTargets, mirrorContributionId, mirrorContributions, summariseSwitch } from '../../../src/domain/switches/tracking';
import type { Instrument, Portfolio, PortfolioSwitch, PricePoint } from '../../../src/domain/types';
import { tx } from '../../helpers';

const near = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b) < eps).toBe(true);
const px = (instrumentId: string, date: string, close: string, source: PricePoint['source'] = 'market'): PricePoint => ({ instrumentId, date, close, source });

describe('metricsOf', () => {
  it('total, CAGR, drawdown and Sharpe', () => {
    const s = [
      { date: '2024-01-01', value: 100 },
      ...Array.from({ length: 30 }, (_, i) => ({ date: `2024-06-${String(i + 1).padStart(2, '0')}`, value: 100 + (i % 2 ? 5 : -5) })),
      { date: '2026-01-01', value: 121 },
    ];
    const m = metricsOf(s)!;
    near(m.totalReturn, 0.21);
    near(m.cagr!, Math.pow(1.21, 365.25 / 731) - 1);
    near(m.maxDrawdown, 95 / 105 - 1);
    expect(m.volatility! > 0).toBe(true);
    near(m.sharpe!, (m.cagr! - RISK_FREE_RATE) / m.volatility!);
  });
  it('short series: no CAGR/Sharpe; too short → null', () => {
    expect(metricsOf([{ date: '2026-10-01', value: 1 }])).toBeNull();
    const m = metricsOf([{ date: '2026-10-01', value: 100 }, { date: '2026-10-30', value: 110 }])!;
    expect(m.cagr).toBeNull();
    expect(m.sharpe).toBeNull();
  });
});

describe('runBacktest', () => {
  // Mon Oct 5 – Fri Oct 9 2026
  const points = [
    px('A', '2026-10-05', '100'), px('A', '2026-10-06', '110'), px('A', '2026-10-09', '120'),
    px('B', '2026-10-05', '50'), px('B', '2026-10-09', '45'),
    px('M', '2026-10-07', '1', 'manual'),
  ];
  const mixes: Mix[] = [
    { portfolioId: 'p1', name: 'All A', lines: [{ instrumentId: 'A', weight: 1 }] },
    { portfolioId: 'p2', name: 'Half B', lines: [{ instrumentId: 'B', weight: 0.5 }] }, // 50% cash
  ];
  it('invests the same amount in each mix and ranks by final value', () => {
    const bt = runBacktest(mixes, points, { amount: 10000, start: '2026-10-05', end: '2026-10-09', assumeFlatBefore: false })!;
    expect(bt.results.map((r) => r.name)).toEqual(['All A', 'Half B']);
    expect(bt.results[0]!.series.map((d) => d.value)).toEqual([10000, 11000, 11000, 11000, 12000]);
    expect(bt.results[1]!.series[4]!.value).toBe(5000 + 100 * 45); // 100 units of B + $5,000 cash
    near(bt.results[0]!.metrics!.totalReturn, 0.2);
  });
  it('moves the start to the latest first price and says which asset limits it', () => {
    const withM = [...mixes, { portfolioId: 'p3', name: 'Manual', lines: [{ instrumentId: 'M', weight: 1 }] }];
    const bt = runBacktest(withM, points, { amount: 1000, start: '2026-10-05', end: '2026-10-09', assumeFlatBefore: false })!;
    expect(bt.start).toBe('2026-10-07');
    expect(bt.limitedBy).toEqual({ instrumentId: 'M', firstDate: '2026-10-07' });
    const flat = runBacktest(withM, points, { amount: 1000, start: '2026-10-05', end: '2026-10-09', assumeFlatBefore: true })!;
    expect(flat.start).toBe('2026-10-05');
    expect(flat.limitedBy).toBeUndefined();
  });
  it('Max uses the earliest common date; an unpriced asset → null', () => {
    const bt = runBacktest(mixes, points, { amount: 1, start: null, end: '2026-10-09', assumeFlatBefore: false })!;
    expect(bt.start).toBe('2026-10-05');
    expect(runBacktest([{ portfolioId: 'x', name: 'x', lines: [{ instrumentId: 'ZZZ', weight: 1 }] }], points, { amount: 1, start: null, end: '2026-10-09', assumeFlatBefore: false })).toBeNull();
  });
  it('period starts', () => {
    expect(periodStart('1Y', '2026-11-03')).toBe('2025-11-03');
    expect(periodStart('3M', '2026-05-31')).toBe('2026-02-28');
    expect(periodStart('Max', '2026-11-03')).toBeNull();
  });
});

describe('switch tracking', () => {
  const sw: PortfolioSwitch = { id: 's1', switchDate: '2026-10-05', fromPortfolioId: 'old', toPortfolioId: 'new', freezeBaseline: true, mirrorContributions: true, createdAt: 't' };
  it('summarises old vs new since the switch date, with an optional fee', () => {
    const base = [{ date: '2026-10-02', value: 900, invested: 900 }, { date: '2026-10-05', value: 1000, invested: 1000 }, { date: '2026-10-09', value: 1050, invested: 1000 }];
    const next = [{ date: '2026-10-05', value: 990, invested: 990 }, { date: '2026-10-09', value: 1089, invested: 990 }];
    const s = summariseSwitch(sw, base, next, '1')!;
    expect([s.baselineStart, s.newStart, s.baselineNow, s.newNow]).toEqual([1000, 990, 1050, 1089]);
    near(s.difference, 39);
    near(s.baselineReturn, 0.05);
    near(s.newReturn, 0.1);
    near(s.newAfterFee!, 1089 * Math.pow(0.99, 4 / 365.25));
    expect(s.baselineSeries).toHaveLength(2);
  });

  const baseline = { id: 'old', name: 'Old', buyMode: 'fractional', fractionDigits: 6, topUpWholeShares: false, createdAt: 't' } as Portfolio;
  const opening = [
    tx('OPENING', '2026-10-05', { portfolioId: 'old', instrumentId: 'A', quantity: '30', price: '100', amount: '3000' }),
    tx('OPENING', '2026-10-05', { portfolioId: 'old', instrumentId: 'B', quantity: '20', price: '50', amount: '1000' }),
  ];
  it('baseline mix = holdings on the switch date when there is no target allocation', () => {
    expect(baselineTargets(sw, [], opening, new Set(['A', 'B']), '2026-10-09')).toEqual([
      { instrumentId: 'A', pct: '75' },
      { instrumentId: 'B', pct: '25' },
    ]);
  });
  it('mirrors new money into the baseline once, with a fixed id, waiting for closes', () => {
    const newTxs = [
      tx('OPENING', '2026-10-05', { portfolioId: 'new', instrumentId: 'C', quantity: '1', price: '1', amount: '1' }),
      tx('DEPOSIT', '2026-10-06', { portfolioId: 'new', amount: '400', contributionId: 'c1' }),
      tx('DEPOSIT', '2026-10-12', { portfolioId: 'new', amount: '100', contributionId: 'c2' }), // after closes available
    ];
    const instruments = new Map<string, Instrument>([
      ['A', { id: 'A', name: 'A', symbol: 'A', assetClass: 'etf', priceSource: 'market', currency: 'USD', createdAt: 't', updatedAt: 't' }],
      ['B', { id: 'B', name: 'B', symbol: 'B', assetClass: 'etf', priceSource: 'market', currency: 'USD', createdAt: 't', updatedAt: 't' }],
    ]);
    const points = [px('A', '2026-10-05', '100'), px('A', '2026-10-06', '100'), px('B', '2026-10-05', '50'), px('B', '2026-10-06', '50')];
    let seq = 100;
    const ctx = { sw, baseline, newTxs, baselineTxs: opening, baselinePlans: [], baselineAssetIds: new Set(['A', 'B']), instruments, points, throughTradeDate: '2026-10-09', nextSeq: () => ++seq, now: 'n' };
    const run = mirrorContributions(ctx);
    expect(run.mirrored).toBe(1);
    expect(run.waiting).toBe(1);
    const dep = run.transactions.find((t) => t.type === 'DEPOSIT')!;
    expect(dep.amount).toBe('400');
    expect(dep.contributionId).toBe(mirrorContributionId('s1', 'c1'));
    expect(run.transactions.filter((t) => t.type === 'BUY').map((t) => [t.instrumentId, t.quantity])).toEqual([['A', '3'], ['B', '2']]);
    // Already mirrored → nothing new
    const again = mirrorContributions({ ...ctx, baselineTxs: [...opening, ...run.transactions] });
    expect(again.mirrored).toBe(0);
    // Off → nothing
    expect(mirrorContributions({ ...ctx, sw: { ...sw, mirrorContributions: false } }).transactions).toEqual([]);
  });
});

describe('actualPerformance', () => {
  it('uses the time-weighted index over the period', async () => {
    const { actualPerformance } = await import('../../../src/domain/compare/actual');
    const s = [
      { date: '2026-09-01', value: 1000, invested: 1000 },
      { date: '2026-10-01', value: 1100, invested: 1000 },
      { date: '2026-10-02', value: 2200, invested: 2100 }, // +$1,100 added
      { date: '2026-10-05', value: 2420, invested: 2100 },
    ];
    const a = actualPerformance(s, '2026-10-01')!;
    expect(a.since).toBe('2026-10-01');
    near(a.metrics!.totalReturn, 0.1);
    expect(a.partial).toBe(false);
    const all = actualPerformance(s, '2026-01-01')!;
    expect(all.partial).toBe(true);
    near(all.metrics!.totalReturn, 0.21);
  });
});
