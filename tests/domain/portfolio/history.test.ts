import { describe, expect, it } from 'vitest';
import { cagr, rangeOf, thin, twr, valueHistory, type DayValue } from '../../../src/domain/portfolio/history';
import { project, yearlyContributions } from '../../../src/domain/portfolio/projection';
import type { ContributionRule, PricePoint } from '../../../src/domain/types';
import { buy, tx } from '../../helpers';

const px = (instrumentId: string, date: string, close: string, extra: Partial<PricePoint> = {}): PricePoint => ({ instrumentId, date, close, source: 'market', ...extra });
const close = (a: number, b: number) => expect(Math.abs(a - b) < 1e-9).toBe(true);

describe('valueHistory', () => {
  // Mon 2026-10-05 … Fri 2026-10-09
  const txs = [tx('DEPOSIT', '2026-10-05', { amount: '1000' }), buy('2026-10-05', 'A', '10', '100')];
  const points = [px('A', '2026-10-05', '100'), px('A', '2026-10-06', '110'), px('A', '2026-10-08', '105')];

  it('values each trading day with that day’s close, carrying prices over gaps', () => {
    const h = valueHistory(txs, points, '2026-10-09');
    expect(h.map((d) => d.date)).toEqual(['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09']);
    expect(h.map((d) => d.value)).toEqual([1000, 1100, 1100, 1050, 1050]);
    expect(h.every((d) => d.invested === 1000)).toBe(true);
  });

  it('skips weekends and holidays but keeps the end date', () => {
    const h = valueHistory(txs, points, '2026-10-11'); // Sunday
    expect(h.map((d) => d.date).slice(-2)).toEqual(['2026-10-09', '2026-10-11']);
  });

  it('uses a live price only on the end date', () => {
    const live = [...points, px('A', '2026-10-09', '120', { intraday: true })];
    const h = valueHistory(txs, live, '2026-10-09');
    expect(h[h.length - 1]!.value).toBe(1200);
    const h2 = valueHistory(txs, live, '2026-10-12');
    expect(h2.find((d) => d.date === '2026-10-09')!.value).toBe(1050); // intraday ignored on past days
  });

  it('uses cost basis before the first price, and 0 for never-priced assets', () => {
    const late = [px('A', '2026-10-07', '120')];
    const h = valueHistory(txs, late, '2026-10-07');
    expect(h.map((d) => d.value)).toEqual([1000, 1000, 1200]);
    expect(valueHistory(txs, [], '2026-10-06').map((d) => d.value)).toEqual([0, 0]);
  });

  it('manual prices stay flat between updates', () => {
    const t = [tx('OPENING', '2026-10-05', { instrumentId: 'F', quantity: '100', price: '10', amount: '1000' })];
    const h = valueHistory(t, [px('F', '2026-10-05', '10', { source: 'manual' }), px('F', '2026-10-08', '11', { source: 'manual' })], '2026-10-09');
    expect(h.map((d) => d.value)).toEqual([1000, 1000, 1000, 1100, 1100]);
    expect(h[0]!.invested).toBe(1000); // opening positions count as invested
  });
});

describe('twr', () => {
  it('ignores the timing of contributions', () => {
    // +10%, then $1,100 added at end of day 2, then +10% on everything.
    const s: DayValue[] = [
      { date: 'd0', value: 1000, invested: 1000 },
      { date: 'd1', value: 1100, invested: 1000 },
      { date: 'd2', value: 2200, invested: 2100 },
      { date: 'd3', value: 2420, invested: 2100 },
    ];
    close(twr(s), 1.1 * 1.1 - 1); // 21%, although value − invested is only +15%
    close(twr(s, 2), 0.1);
  });
  it('counts a fee (no flow) as a loss and skips days with no value', () => {
    const s: DayValue[] = [
      { date: 'a', value: 0, invested: 0 },
      { date: 'b', value: 1000, invested: 1000 },
      { date: 'c', value: 990, invested: 1000 },
    ];
    close(twr(s), -0.01);
  });
});

describe('rangeOf', () => {
  const series: DayValue[] = [
    { date: '2026-09-30', value: 1000, invested: 1000 },
    { date: '2026-10-29', value: 1050, invested: 1000 },
    { date: '2026-10-30', value: 1100, invested: 1000 },
    { date: '2026-11-02', value: 1650, invested: 1500 },
  ];
  it('1D compares with the previous trading day', () => {
    const r = rangeOf(series, '1D')!;
    expect(r.points.map((p) => p.date)).toEqual(['2026-10-30', '2026-11-02']);
    close(r.returnPct, (1650 - 500) / 1100 - 1);
    expect(r.gainChange).toBe(50);
  });
  it('1D on a weekend shows the last trading day’s move', () => {
    const r = rangeOf([...series, { date: '2026-11-07', value: 1700, invested: 1500 }], '1D')!; // Saturday
    expect(r.points.map((p) => p.date)).toEqual(['2026-10-30', '2026-11-02']);
  });
  it('1M starts from the last point before the range', () => {
    const r = rangeOf(series, '1M')!;
    expect(r.points[0]!.date).toBe('2026-09-30');
    expect(r.partial).toBe(false);
    expect(r.gainChange).toBe(150);
  });
  it('1Y on short history shows everything and says so', () => {
    const r = rangeOf(series, '1Y')!;
    expect(r.points).toHaveLength(4);
    expect(r.partial).toBe(true);
  });
  it('empty history → null', () => {
    expect(rangeOf([], 'All')).toBeNull();
  });
});

describe('cagr', () => {
  it('needs 90 days of history', () => {
    expect(cagr([{ date: '2026-09-01', value: 1, invested: 1 }, { date: '2026-10-01', value: 2, invested: 1 }])).toBeNull();
  });
  it('annualises the time-weighted return', () => {
    const r = cagr([
      { date: '2024-01-01', value: 1000, invested: 1000 },
      { date: '2026-01-01', value: 1210, invested: 1000 },
    ])!;
    expect(r.days).toBe(731);
    expect(Math.abs(r.rate - 0.1) < 0.001).toBe(true);
  });
});

describe('projection', () => {
  const rule = (amount: string, frequency: ContributionRule['frequency'], extra: Partial<ContributionRule> = {}): ContributionRule => ({
    id: amount, portfolioId: 'p', amount, frequency, startDate: '2026-01-01', paused: false, createdAt: 't', ...extra,
  });
  it('sums running rules per year', () => {
    expect(yearlyContributions([rule('500', 'monthly'), rule('100', 'weekly'), rule('9', 'monthly', { paused: true }), rule('9', 'quarterly', { endDate: '2026-01-31' })], '2026-11-02')).toBe(6000 + 5200);
  });
  it('compounds monthly with contributions', () => {
    const [one, five] = project(10000, 0.1, 0, [1, 5]);
    expect(Math.abs(one!.value - 11000) < 1e-6).toBe(true);
    expect(Math.abs(five!.value - 10000 * 1.1 ** 5) < 1e-6).toBe(true);
    const [c] = project(0, 0, 6000, [1]);
    expect(c).toEqual({ years: 1, value: 6000, contributed: 6000, growth: 0 });
    const [g] = project(1000, 0.12, 1200, [10]);
    expect(g!.contributed).toBe(12000);
    expect(g!.growth > 0).toBe(true);
  });
  it('thin keeps first and last', () => {
    const s = Array.from({ length: 100 }, (_, i) => ({ date: String(i), value: i, invested: 0 }));
    const t = thin(s, 10);
    expect(t).toHaveLength(10);
    expect(t[0]!.value).toBe(0);
    expect(t[9]!.value).toBe(99);
  });
});
