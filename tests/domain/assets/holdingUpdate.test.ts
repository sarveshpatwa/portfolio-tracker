import { describe, expect, it } from 'vitest';
import { d } from '../../../src/domain/money/decimal';
import { holdingUpdateRecords, parseHoldingUpdate, type HoldingUpdateInput } from '../../../src/domain/assets/holdingUpdate';
import { replayLedger } from '../../../src/domain/portfolio/ledger';
import { valuePortfolio } from '../../../src/domain/portfolio/valuation';
import { idGen, tx } from '../../helpers';

const today = '2026-10-30';
const ctx = { unitsHeld: d('5000'), currentPrice: d('1'), today };
const input = (fields: Partial<HoldingUpdateInput>): HoldingUpdateInput => ({
  date: '2026-10-30',
  price: '1.00',
  unitsMode: 'add',
  units: '',
  source: '',
  ...fields,
});
let seq = 0;
const txCtx = { portfolioId: 'p1', date: '2026-10-30', newId: idGen(), nextSeq: () => ++seq, now: '' };

describe('parseHoldingUpdate', () => {
  it('adds units at an unchanged $1.00 price without a new price point', () => {
    const r = parseHoldingUpdate(input({ units: '250', source: 'earned' }), ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.priceChanged).toBe(false);
    expect(r.value.unitsChange.toString()).toBe('250');
    expect(r.value.unitsAfter.toString()).toBe('5250');
    expect(holdingUpdateRecords(r.value, 'X', txCtx).pricePoint).toBeUndefined();
  });

  it('computes the change from a new total (statement)', () => {
    const up = parseHoldingUpdate(input({ unitsMode: 'total', units: '5,400', source: 'money' }), ctx);
    expect(up.ok && up.value.unitsChange.toString()).toBe('400');
    const down = parseHoldingUpdate(input({ unitsMode: 'total', units: '4800' }), ctx);
    expect(down.ok && down.value.unitsChange.toString()).toBe('-200');
    expect(down.ok && down.value.source).toBeUndefined(); // no source needed for a reduction
  });

  it('updates the price only', () => {
    const r = parseHoldingUpdate(input({ price: '1.05' }), ctx);
    expect(r.ok && r.value.priceChanged).toBe(true);
    expect(r.ok && r.value.unitsChange.isZero()).toBe(true);
  });

  it('requires a source when units are added, and rejects no-op updates', () => {
    const noSource = parseHoldingUpdate(input({ units: '10' }), ctx);
    expect(!noSource.ok && noSource.errors.source).toBe('Choose where the new units came from.');
    const noop = parseHoldingUpdate(input({}), ctx);
    expect(!noop.ok && noop.errors.form).toBe('Nothing to save — change the price or the units.');
    const sameTotal = parseHoldingUpdate(input({ unitsMode: 'total', units: '5000' }), ctx);
    expect(sameTotal.ok).toBe(false);
  });

  it('validates numbers and dates', () => {
    const r = parseHoldingUpdate(input({ date: '2026-11-02', price: '0', units: '-5' }), ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(['date', 'price', 'units']);
  });
});

describe('holdingUpdateRecords → ledger', () => {
  const opening = tx('OPENING', '2026-01-02', { instrumentId: 'X', quantity: '5000', price: '1', amount: '5000' });

  it('earned units at $1.00 show up as gain, not as invested money', () => {
    const r = parseHoldingUpdate(input({ units: '250', source: 'earned' }), ctx);
    if (!r.ok) throw new Error('parse failed');
    const { transactions } = holdingUpdateRecords(r.value, 'X', txCtx);
    expect(transactions.map((t) => t.type)).toEqual(['REINVEST']);
    const state = replayLedger([opening, ...transactions]);
    const v = valuePortfolio(state, new Map([['X', d('1')]]));
    expect(v.totalValue.toString()).toBe('5250');
    expect(v.netInvested.toString()).toBe('5000');
    expect(v.totalGain.toString()).toBe('250');
    expect(v.totalGainPct?.toString()).toBe('0.05');
    expect(v.holdings[0]?.gain.toString()).toBe('250'); // holding and portfolio gain agree
    expect(state.income.toString()).toBe('250');
  });

  it('units bought with new money count as invested', () => {
    const r = parseHoldingUpdate(input({ units: '250', source: 'money' }), ctx);
    if (!r.ok) throw new Error('parse failed');
    const { transactions } = holdingUpdateRecords(r.value, 'X', txCtx);
    expect(transactions.map((t) => t.type)).toEqual(['DEPOSIT', 'BUY']);
    const v = valuePortfolio(replayLedger([opening, ...transactions]), new Map([['X', d('1')]]));
    expect(v.netInvested.toString()).toBe('5250');
    expect(v.totalGain.toString()).toBe('0');
    expect(v.cash.toString()).toBe('0');
  });

  it('a lower total sells the difference into cash', () => {
    const r = parseHoldingUpdate(input({ unitsMode: 'total', units: '4800' }), ctx);
    if (!r.ok) throw new Error('parse failed');
    const { transactions } = holdingUpdateRecords(r.value, 'X', txCtx);
    expect(transactions.map((t) => t.type)).toEqual(['SELL']);
    const v = valuePortfolio(replayLedger([opening, ...transactions]), new Map([['X', d('1')]]));
    expect(v.holdings[0]?.quantity.toString()).toBe('4800');
    expect(v.cash.toString()).toBe('200');
    expect(v.totalValue.toString()).toBe('5000');
  });

  it('records units and a new price together', () => {
    const r = parseHoldingUpdate(input({ price: '1.10', units: '100', source: 'earned' }), ctx);
    if (!r.ok) throw new Error('parse failed');
    const rec = holdingUpdateRecords(r.value, 'X', txCtx);
    expect(rec.pricePoint?.close).toBe('1.1');
    expect(rec.transactions[0]?.amount).toBe('110');
  });
});

describe('confirming an unchanged price', () => {
  it('the same price on a later date is saved (it confirms the price)', () => {
    const input: HoldingUpdateInput = { date: '2026-11-07', price: '12', units: '', unitsMode: 'add', source: '' };
    const r = parseHoldingUpdate(input, { unitsHeld: d('10'), currentPrice: d('12'), currentPriceDate: '2026-10-20', today: '2026-11-07' });
    expect(r.ok && r.value.priceChanged).toBe(true);
    const same = parseHoldingUpdate(input, { unitsHeld: d('10'), currentPrice: d('12'), currentPriceDate: '2026-11-07', today: '2026-11-07' });
    expect(same.ok).toBe(false);
  });
});
