import { describe, expect, it } from 'vitest';
import { Dec, d } from '../../../src/domain/money/decimal';
import { LedgerError, replayLedger } from '../../../src/domain/portfolio/ledger';
import { valuePortfolio } from '../../../src/domain/portfolio/valuation';
import { buy, tx } from '../../helpers';

describe('replayLedger', () => {
  it('tracks cash, positions and cost basis', () => {
    const state = replayLedger([
      tx('DEPOSIT', '2026-01-05', { amount: '1000' }),
      buy('2026-01-05', 'VTI', '2', '300'),
      buy('2026-02-05', 'VTI', '1', '330'),
      buy('2026-02-05', 'BND', '3', '20'),
    ]);
    expect(state.cash.toString()).toBe('10');
    expect(state.netInvested.toString()).toBe('1000');
    expect(state.positions.get('VTI')?.quantity.toString()).toBe('3');
    expect(state.positions.get('VTI')?.costBasis.toString()).toBe('930');
    expect(state.positions.get('BND')?.costBasis.toString()).toBe('60');
  });

  it('removes a proportional slice of cost on sells (average cost)', () => {
    const state = replayLedger([
      tx('DEPOSIT', '2026-01-05', { amount: '1000' }),
      buy('2026-01-05', 'VTI', '2', '300'),
      buy('2026-01-06', 'VTI', '2', '400'), // 4 shares, cost 1400, avg 350
      tx('SELL', '2026-03-01', { instrumentId: 'VTI', quantity: '1', price: '500', amount: '500' }),
    ]);
    const vti = state.positions.get('VTI');
    expect(vti?.quantity.toString()).toBe('3');
    expect(vti?.costBasis.toString()).toBe('1050');
    expect(state.realizedGain.toString()).toBe('150');
  });

  it('replays in date order regardless of input order, and respects asOf', () => {
    const txs = [buy('2026-02-01', 'VTI', '1', '100'), tx('DEPOSIT', '2026-01-01', { amount: '500' })];
    expect(replayLedger(txs).cash.toString()).toBe('400');
    expect(replayLedger(txs, '2026-01-31').cash.toString()).toBe('500');
  });

  it('treats OPENING as invested shares with no cash movement', () => {
    const state = replayLedger([
      tx('OPENING', '2026-09-15', { instrumentId: 'VTI', quantity: '120.5', price: '285.10', amount: '34354.55' }),
    ]);
    expect(state.cash.toString()).toBe('0');
    expect(state.netInvested.toString()).toBe('34354.55');
    expect(state.positions.get('VTI')?.costBasis.toString()).toBe('34354.55');
  });

  it('deducts fees from cash without changing invested', () => {
    const state = replayLedger([tx('DEPOSIT', '2026-01-01', { amount: '100' }), tx('FEE', '2026-02-01', { amount: '1.25' })]);
    expect(state.cash.toString()).toBe('98.75');
    expect(state.feesPaid.toString()).toBe('1.25');
    expect(state.netInvested.toString()).toBe('100');
  });

  it('rejects selling more than held', () => {
    expect(() =>
      replayLedger([buy('2026-01-01', 'VTI', '1', '10'), tx('SELL', '2026-01-02', { instrumentId: 'VTI', quantity: '2', amount: '20' })]),
    ).toThrow(LedgerError);
  });
});

describe('valuePortfolio', () => {
  it('computes value, gain and weights', () => {
    const state = replayLedger([
      tx('DEPOSIT', '2026-01-05', { amount: '1000' }),
      buy('2026-01-05', 'VTI', '2', '300'),
      buy('2026-01-05', 'BND', '10', '39'),
    ]);
    const v = valuePortfolio(state, new Map([['VTI', d('350')], ['BND', d('40')]]));
    expect(v.totalValue.toString()).toBe('1110'); // 700 + 400 + 10 cash
    expect(v.totalGain.toString()).toBe('110');
    expect(v.totalGainPct?.toString()).toBe('0.11');
    const vti = v.holdings.find((h) => h.instrumentId === 'VTI');
    expect(vti?.gain.toString()).toBe('100');
    expect(vti?.gainPct?.toFixed(4)).toBe('0.1667');
    expect(Dec.sum(v.holdings.map((h) => h.weight)).add(v.cashWeight).toFixed(9)).toBe('1.000000000');
  });

  it('flags holdings without a price instead of guessing', () => {
    const state = replayLedger([buy('2026-01-05', 'FUNDA', '5', '10')]);
    const v = valuePortfolio(state, new Map());
    expect(v.missingPrices).toEqual(['FUNDA']);
    expect(v.totalValue.toString()).toBe('-50');
  });

  it('returns null gain % for an empty portfolio', () => {
    expect(valuePortfolio(replayLedger([]), new Map()).totalGainPct).toBeNull();
  });
});
