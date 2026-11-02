import { describe, expect, it } from 'vitest';
import { d } from '../../../src/domain/money/decimal';
import { pricesForTrade, recurringContributionId, runRecurring, usableTargets, type RecurringContext } from '../../../src/domain/contributions/execution';
import { contributionTransactions } from '../../../src/domain/contributions/transactions';
import { planPurchase } from '../../../src/domain/contributions/purchase';
import { replayLedger } from '../../../src/domain/portfolio/ledger';
import type { AllocationPlan, ContributionRule, Instrument, Portfolio, PricePoint } from '../../../src/domain/types';

const inst = (id: string, priceSource: 'market' | 'manual'): Instrument => ({
  id, name: id, assetClass: 'etf', priceSource, currency: 'USD', createdAt: '', updatedAt: '', ...(priceSource === 'market' ? { symbol: id } : {}),
});
const instruments = new Map([['VTI', inst('VTI', 'market')], ['FUND', inst('FUND', 'manual')]]);
const mp = (id: string, date: string, close: string, intraday = false): PricePoint => ({ instrumentId: id, date, close, source: 'market', ...(intraday ? { intraday } : {}) });
const manual = (date: string, close: string): PricePoint => ({ instrumentId: 'FUND', date, close, source: 'manual' });

const points: PricePoint[] = [
  mp('VTI', '2026-08-06', '280'),
  mp('VTI', '2026-09-04', '285'),
  mp('VTI', '2026-09-08', '286'), // Sep 6 is Sunday, Sep 7 Labor Day → trades Sep 8
  mp('VTI', '2026-10-06', '290'),
  mp('VTI', '2026-10-30', '292'),
  mp('VTI', '2026-11-02', '293', true), // live, not final
  manual('2026-07-01', '10'),
  manual('2026-10-01', '11'),
];

const portfolio: Portfolio = { id: 'P', name: 'Growth', createdAt: '', buyMode: 'fractional', fractionDigits: 6, topUpWholeShares: false };
const plan = (id: string, version: number, effectiveFrom: string, vti: string, fund: string): AllocationPlan => ({
  id, portfolioId: 'P', version, effectiveFrom, createdAt: '', targets: [{ instrumentId: 'VTI', pct: vti }, { instrumentId: 'FUND', pct: fund }],
});
const rule = (fields: Partial<ContributionRule> = {}): ContributionRule => ({
  id: 'R', portfolioId: 'P', amount: '500', frequency: 'monthly', startDate: '2026-08-06', paused: false, createdAt: '', ...fields,
});
let seq = 0;
const ctx = (fields: Partial<RecurringContext> = {}): RecurringContext => ({
  rule: rule(),
  portfolio,
  plans: [plan('v1', 1, '2026-01-01', '60', '40')],
  assetIds: new Set(['VTI', 'FUND']),
  instruments,
  points,
  throughTradeDate: '2026-10-30',
  nextSeq: () => ++seq,
  now: '2026-11-02T00:00:00Z',
  nameOf: (id) => id,
  ...fields,
});

describe('pricesForTrade', () => {
  it('recurring uses the exact final close of the trade date', () => {
    const r = pricesForTrade(['VTI', 'FUND'], instruments, points, '2026-09-08', 'close');
    expect(r.prices.get('VTI')?.toString()).toBe('286');
    expect(r.prices.get('FUND')?.toString()).toBe('10'); // manual price held flat
    expect(r.missing).toEqual([]);
  });

  it('waits when the close is not downloaded yet (only a live price exists)', () => {
    const r = pricesForTrade(['VTI'], instruments, points, '2026-11-02', 'close');
    expect(r.missing).toEqual([{ instrumentId: 'VTI', reason: 'not-downloaded-yet' }]);
  });

  it('one-time today uses the latest (live) price; past dates use the close on or before', () => {
    expect(pricesForTrade(['VTI'], instruments, points, '2026-11-02', 'latest').prices.get('VTI')?.toString()).toBe('293');
    const past = pricesForTrade(['VTI'], instruments, points, '2026-09-06', 'asOf');
    expect(past.prices.get('VTI')?.toString()).toBe('285');
    expect(past.dates.get('VTI')).toBe('2026-09-04');
  });

  it('reports a manual asset with no price that early', () => {
    expect(pricesForTrade(['FUND'], instruments, points, '2026-06-01', 'asOf').missing).toEqual([{ instrumentId: 'FUND', reason: 'no-price' }]);
  });
});

describe('runRecurring', () => {
  it('catches up every missed month at each trade date’s close', () => {
    const r = runRecurring(ctx());
    expect(r.executed.map((e) => [e.scheduledDate, e.tradeDate])).toEqual([
      ['2026-08-06', '2026-08-06'],
      ['2026-09-06', '2026-09-08'],
      ['2026-10-06', '2026-10-06'],
    ]);
    expect(r.lastScheduledDate).toBe('2026-10-06');
    const sep = r.executed[1]!;
    expect(sep.plan.lines.find((l) => l.instrumentId === 'VTI')?.price.toString()).toBe('286');
    // $300 / 286 = 1.048951… shares
    expect(sep.plan.lines.find((l) => l.instrumentId === 'VTI')?.quantity.toString()).toBe('1.048951');
  });

  it('uses deterministic ids so two devices create identical entries', () => {
    const a = runRecurring(ctx()).executed[0]!.transactions.map((t) => t.id);
    const b = runRecurring(ctx()).executed[0]!.transactions.map((t) => t.id);
    expect(a).toEqual(b);
    expect(a[0]).toBe(`${recurringContributionId('R', '2026-08-06')}:deposit`);
  });

  it('resumes after the last processed date and replays cleanly', () => {
    const r = runRecurring(ctx({ rule: rule({ lastScheduledDate: '2026-09-06' }) }));
    expect(r.executed.map((e) => e.scheduledDate)).toEqual(['2026-10-06']);
    const state = replayLedger(r.executed.flatMap((e) => e.transactions));
    expect(state.netInvested.toString()).toBe('500');
    expect(state.cash.lt('0.01')).toBe(true);
  });

  it('applies the allocation version in effect on each date', () => {
    const plans = [plan('v1', 1, '2026-01-01', '60', '40'), plan('v2', 2, '2026-09-15', '100', '0')];
    const r = runRecurring(ctx({ plans }));
    expect(r.executed[2]!.plan.lines.map((l) => l.instrumentId)).toEqual(['VTI']); // Oct uses v2
    expect(r.executed[0]!.transactions[0]!.allocationPlanId).toBe('v1');
  });

  it('waits at a date whose close is not downloaded yet', () => {
    const r = runRecurring(ctx({ rule: rule({ startDate: '2026-10-06', frequency: 'weekly', lastScheduledDate: '2026-10-27' }), throughTradeDate: '2026-11-03' }));
    // Nov 3 close is missing → waits (nothing executed)
    expect(r.executed).toEqual([]);
    expect(r.waiting?.scheduledDate).toBe('2026-11-03');
  });

  it('blocks with a clear reason when a manual asset has no early price', () => {
    const r = runRecurring(ctx({ rule: rule({ startDate: '2026-06-01' }) }));
    expect(r.executed).toEqual([]);
    // VTI's history starts in August and the fund's first price is July 1 → neither can be priced.
    expect(r.blocked?.message).toContain('No price for VTI, FUND on or before 2026-06-01');
  });

  it('blocks when the allocation no longer totals 100% (asset removed)', () => {
    const r = runRecurring(ctx({ assetIds: new Set(['VTI']) }));
    expect(r.blocked?.message).toContain('totals 100%');
    expect(usableTargets(plan('v', 1, '2026-01-01', '100', '0'), new Set(['VTI'])).ok).toBe(true);
  });
});

describe('contributionTransactions with existing cash', () => {
  it('deposits only the new money while buying with new money + cash', () => {
    const purchase = planPurchase({ amount: d('600'), targets: [{ instrumentId: 'VTI', pct: '100' }], prices: new Map([['VTI', d('300')]]), mode: 'whole' });
    const txs = contributionTransactions(purchase, { portfolioId: 'P', date: '2026-11-02', newId: () => 'x' + ++seq, nextSeq: () => ++seq, now: '' }, { depositAmount: d('500') });
    const deposit = txs.find((t) => t.type === 'DEPOSIT');
    expect(deposit?.amount).toBe('500');
    const state = replayLedger([{ id: 'c', seq: 0, portfolioId: 'P', type: 'DEPOSIT', date: '2026-10-01', amount: '100', createdAt: '' }, ...txs]);
    expect(state.positions.get('VTI')?.quantity.toString()).toBe('2');
    expect(state.cash.toString()).toBe('0');
  });
});
