import { describe, expect, it } from 'vitest';
import { planAssetDeletion } from '../../../src/domain/assets/deleteAsset';
import { replayLedger } from '../../../src/domain/portfolio/ledger';
import { buy, tx } from '../../helpers';

describe('planAssetDeletion', () => {
  it('removes every entry for the asset, including a starting position', () => {
    const txs = [
      tx('OPENING', '2026-01-02', { instrumentId: 'X', quantity: '5000', price: '1', amount: '5000' }),
      tx('REINVEST', '2026-02-02', { instrumentId: 'X', quantity: '250', price: '1', amount: '250' }),
      tx('OPENING', '2026-01-02', { instrumentId: 'Y', quantity: '10', price: '10', amount: '100' }),
    ];
    const plan = planAssetDeletion(txs, 'X');
    expect(plan.removeIds).toHaveLength(2);
    const state = replayLedger(plan.remaining);
    expect(state.netInvested.toString()).toBe('100');
    expect(state.positions.has('X')).toBe(false);
  });

  it('removes a deposit that only funded this asset, so no stray cash or invested remains', () => {
    const txs = [
      tx('DEPOSIT', '2026-03-01', { amount: '150', contributionId: 'c1' }),
      { ...buy('2026-03-01', 'X', '150', '1'), contributionId: 'c1' },
      tx('DEPOSIT', '2026-03-01', { amount: '50' }), // unrelated cash
    ];
    const plan = planAssetDeletion(txs, 'X');
    const state = replayLedger(plan.remaining);
    expect(state.cash.toString()).toBe('50');
    expect(state.netInvested.toString()).toBe('50');
    expect(plan.keptCash.toString()).toBe('0');
  });

  it('keeps a shared contribution deposit; this asset’s share becomes cash', () => {
    const txs = [
      tx('DEPOSIT', '2026-03-01', { amount: '1000', contributionId: 'c1' }),
      { ...buy('2026-03-01', 'X', '400', '1'), contributionId: 'c1' },
      { ...buy('2026-03-01', 'Y', '60', '10'), contributionId: 'c1' },
    ];
    const plan = planAssetDeletion(txs, 'X');
    expect(plan.keptCash.toString()).toBe('400');
    const state = replayLedger(plan.remaining);
    expect(state.cash.toString()).toBe('400');
    expect(state.netInvested.toString()).toBe('1000');
    expect(plan.cashGoesNegative).toBe(false);
  });

  it('warns when the asset’s sale had funded other purchases', () => {
    const txs = [
      tx('OPENING', '2026-01-02', { instrumentId: 'X', quantity: '100', price: '1', amount: '100' }),
      tx('SELL', '2026-02-01', { instrumentId: 'X', quantity: '100', price: '1', amount: '100' }),
      buy('2026-02-02', 'Y', '10', '10'),
    ];
    expect(planAssetDeletion(txs, 'X').cashGoesNegative).toBe(true);
  });
});
