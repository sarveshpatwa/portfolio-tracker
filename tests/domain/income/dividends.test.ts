import { describe, expect, it } from 'vitest';
import { correctedDividend, dividendId, dueDividends, estimateMonth, payableDate, yieldOn } from '../../../src/domain/income/dividends';
import { d } from '../../../src/domain/money/decimal';
import { replayLedger } from '../../../src/domain/portfolio/ledger';
import { mergeSnapshots } from '../../../src/domain/sync/merge';
import type { Instrument, Transaction } from '../../../src/domain/types';
import { tx } from '../../helpers';

const MMF = 'mmf';
// The user's October 2026: 6,220.25 units on Oct 1, two biweekly buys of 69.045 units.
const october: Transaction[] = [
  tx('OPENING', '2026-09-15', { instrumentId: MMF, quantity: '6209.42', price: '1', amount: '6209.42' }),
  tx('REINVEST', '2026-10-01', { instrumentId: MMF, quantity: '10.83', price: '1', amount: '10.83' }),
  tx('DEPOSIT', '2026-10-10', { amount: '69.045' }),
  tx('BUY', '2026-10-10', { instrumentId: MMF, quantity: '69.045', price: '1', amount: '69.045' }),
  tx('DEPOSIT', '2026-10-24', { amount: '69.045' }),
  tx('BUY', '2026-10-24', { instrumentId: MMF, quantity: '69.045', price: '1', amount: '69.045' }),
];
const yields = [{ date: '2026-09-01', pct: '3.84' }];
const instrument = (since: string, ys = yields): Instrument => ({
  id: MMF, name: 'Cash Reserves', assetClass: 'fund', priceSource: 'manual', currency: 'USD', createdAt: 't', updatedAt: 't', income: { since, yields: ys },
});

describe('income fund dividends', () => {
  it('payable on the first trading day of the next month', () => {
    expect(payableDate('2026-10')).toBe('2026-11-02'); // Nov 1 is a Sunday
    expect(payableDate('2026-09')).toBe('2026-10-01');
    expect(payableDate('2026-12')).toBe('2027-01-04'); // Jan 1 holiday, then weekend
  });
  it('estimates October at 3.84% to the cent of the actual 20.48', () => {
    const e = estimateMonth(october, MMF, yields, '2026-10')!;
    expect(e.days).toBe(31);
    expect(e.amount.toFixed(2)).toBe('20.49');
    expect(Math.round(e.averageUnits)).toBe(6282);
  });
  it('purchases earn from the next day; the yield in effect changes by date', () => {
    const one = [tx('BUY', '2026-11-10', { instrumentId: MMF, quantity: '1000', price: '1', amount: '1000' })];
    const e = estimateMonth(one, MMF, [{ date: '2026-11-01', pct: '3.65' }, { date: '2026-11-21', pct: '7.3' }], '2026-11')!;
    // Nov 11–20: 10 days × 1000 × 3.65%/365 = 1.00 ; Nov 21–30: 10 days × 7.3% → 2.00
    expect(e.amount.toFixed(4)).toBe('3.0000');
    expect(yieldOn([{ date: '2026-11-05', pct: '4' }], '2026-11-01')).toBe(4); // before the first entry → earliest
  });
  it('books only months paid after tracking started, once, with a fixed id', () => {
    let seq = 100;
    const args = { instrument: instrument('2026-11-07'), portfolioId: 'p', txs: october, nextSeq: () => ++seq, now: 'n' };
    expect(dueDividends({ ...args, today: '2026-11-30' })).toEqual([]); // Oct was paid Nov 2, before tracking
    const dec = dueDividends({ ...args, today: '2026-12-01' });
    expect(dec).toHaveLength(1);
    expect(dec[0]).toMatchObject({ id: dividendId(MMF, 'p', '2026-11'), type: 'REINVEST', date: '2026-12-01', estimated: true, price: '1' });
    expect(Number(dec[0]!.quantity) > 19).toBe(true);
    expect(dueDividends({ ...args, txs: [...october, ...dec], today: '2026-12-15' })).toEqual([]);
    expect(replayLedger([...october, ...dec]).positions.get(MMF)!.quantity.gt('6378')).toBe(true);
  });
  it('a correction replaces the estimate and wins in backup merges', () => {
    let seq = 1;
    const [est] = dueDividends({ instrument: instrument('2026-10-01'), portfolioId: 'p', txs: october, today: '2026-11-02', nextSeq: () => ++seq, now: '2026-11-02T00:00:00Z' });
    expect(est!.id).toBe(dividendId(MMF, 'p', '2026-10'));
    const actual = correctedDividend(est!, d('20.48'), '2026-11-05T00:00:00Z');
    expect(actual).toMatchObject({ quantity: '20.48', amount: '20.48', note: 'Dividend 2026-10 (actual)' });
    expect(actual.estimated).toBeUndefined();
    const empty = { portfolios: [], instruments: [], portfolioAssets: [], transactions: [], allocationPlans: [], contributionRules: [], switches: [], prices: [], deletions: [] };
    const merged = mergeSnapshots({ ...empty, transactions: [est!] } as never, { ...empty, transactions: [actual] } as never).result;
    expect(merged.transactions[0]!.quantity).toBe('20.48');
    // ordinary ledger entries stay add-only
    const buy = october[3]!;
    const changed = { ...buy, quantity: '1', updatedAt: '2030-01-01' };
    expect(mergeSnapshots({ ...empty, transactions: [buy] } as never, { ...empty, transactions: [changed] } as never).result.transactions[0]!.quantity).toBe('69.045');
  });
});
