import { describe, expect, it } from 'vitest';
import { Dec, d } from '../../../src/domain/money/decimal';
import { PurchaseError, planPurchase } from '../../../src/domain/contributions/purchase';
import { contributionTransactions } from '../../../src/domain/contributions/transactions';
import { replayLedger } from '../../../src/domain/portfolio/ledger';
import { idGen } from '../../helpers';

const prices = new Map([
  ['VTI', d('292.91')],
  ['BND', d('73.00')],
  ['FUNDA', d('18.80')],
  ['QQQ', d('586.20')],
  ['AGG', d('99.10')],
]);
const growth = [
  { instrumentId: 'VTI', pct: '40' },
  { instrumentId: 'BND', pct: '35' },
  { instrumentId: 'FUNDA', pct: '25' },
];

describe('planPurchase — fractional', () => {
  const plan = planPurchase({ amount: d('1000'), targets: growth, prices, mode: 'fractional' });

  it('splits by target % and floors quantities to 6 dp', () => {
    expect(plan.lines.map((l) => [l.instrumentId, l.targetAmount.toString(), l.quantity.toString()])).toEqual([
      ['VTI', '400', '1.365607'],
      ['BND', '350', '4.79452'],
      ['FUNDA', '250', '13.297872'],
    ]);
  });

  it('never spends more than the contribution, leftover is under a cent', () => {
    expect(plan.spent.lte(plan.amount)).toBe(true);
    expect(plan.leftoverCash.isNegative()).toBe(false);
    expect(plan.leftoverCash.lt('0.01')).toBe(true);
    expect(plan.spent.add(plan.leftoverCash).eq(plan.amount)).toBe(true);
  });

  it('respects a custom number of fraction digits', () => {
    const p = planPurchase({ amount: d('100'), targets: [{ instrumentId: 'VTI', pct: '100' }], prices, mode: 'fractional', fractionDigits: 2 });
    expect(p.lines[0]?.quantity.toString()).toBe('0.34');
  });
});

describe('planPurchase — whole shares', () => {
  const targets = [
    { instrumentId: 'QQQ', pct: '30' },
    { instrumentId: 'AGG', pct: '70' },
  ];

  it('rounds down to whole shares and keeps the remainder as cash', () => {
    const p = planPurchase({ amount: d('1000'), targets, prices, mode: 'whole' });
    expect(p.lines.map((l) => l.quantity.toString())).toEqual(['0', '7']); // $300 can't buy a $586 share
    expect(p.leftoverCash.toString()).toBe('306.3');
  });

  it('top-up buys one more share of the asset furthest below target, never over-filling', () => {
    const p = planPurchase({ amount: d('1000'), targets, prices, mode: 'whole', topUpWholeShares: true });
    // AGG was $6.30 short of its $700 target → one more share. Then only QQQ is
    // under target, but $207.20 can't afford it, so the rest stays as cash.
    expect(p.lines.map((l) => l.quantity.toString())).toEqual(['0', '8']);
    expect(p.leftoverCash.toString()).toBe('207.2');
  });

  it('top-up prefers the bigger shortfall', () => {
    const p = planPurchase({
      amount: d('2000'),
      targets: [
        { instrumentId: 'BND', pct: '50' }, // $1000 / 73 = 13 sh ($949), short $51
        { instrumentId: 'FUNDA', pct: '50' }, // $1000 / 18.8 = 53 sh ($996.40), short $3.60
      ],
      prices,
      mode: 'whole',
      topUpWholeShares: true,
    });
    // Leftover $54.60: BND ($51 short) is unaffordable at $73, so FUNDA gets one share.
    expect(p.lines.map((l) => l.quantity.toString())).toEqual(['13', '54']);
    expect(p.leftoverCash.toString()).toBe('35.8');
  });
});

describe('planPurchase — errors', () => {
  it('refuses invalid allocations, missing prices and non-positive amounts', () => {
    expect(() => planPurchase({ amount: d('100'), targets: [{ instrumentId: 'VTI', pct: '90' }], prices, mode: 'fractional' })).toThrow(PurchaseError);
    expect(() => planPurchase({ amount: d('100'), targets: [{ instrumentId: 'NOPE', pct: '100' }], prices, mode: 'fractional' })).toThrow(/No price/);
    expect(() => planPurchase({ amount: Dec.ZERO, targets: growth, prices, mode: 'fractional' })).toThrow(PurchaseError);
  });

  it('skips 0% targets', () => {
    const p = planPurchase({
      amount: d('100'),
      targets: [{ instrumentId: 'VTI', pct: '100' }, { instrumentId: 'BND', pct: '0' }],
      prices,
      mode: 'fractional',
    });
    expect(p.lines.map((l) => l.instrumentId)).toEqual(['VTI']);
  });
});

describe('contributionTransactions', () => {
  it('produces a deposit plus buys that replay to the planned state', () => {
    let seq = 0;
    const plan = planPurchase({ amount: d('1000'), targets: [{ instrumentId: 'QQQ', pct: '30' }, { instrumentId: 'AGG', pct: '70' }], prices, mode: 'whole' });
    const txs = contributionTransactions(plan, {
      portfolioId: 'p1',
      date: '2026-10-06',
      newId: idGen(),
      nextSeq: () => ++seq,
      now: '2026-10-06T00:00:00Z',
    }, { allocationPlanId: 'v3', scheduledDate: '2026-10-06' });

    expect(txs.map((t) => t.type)).toEqual(['DEPOSIT', 'BUY']); // QQQ bought 0 → no BUY line
    expect(new Set(txs.map((t) => t.contributionId)).size).toBe(1);
    const state = replayLedger(txs);
    expect(state.cash.toString()).toBe('306.3');
    expect(state.positions.get('AGG')?.quantity.toString()).toBe('7');
  });
});
