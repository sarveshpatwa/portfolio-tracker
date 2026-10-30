import { describe, expect, it } from 'vitest';
import { d } from '../../../src/domain/money/decimal';
import {
  OpeningError,
  checkAgainstStatement,
  openingFromUnits,
  openingFromValue,
  openingTransactions,
  switchCost,
} from '../../../src/domain/switches/opening';
import { replayLedger } from '../../../src/domain/portfolio/ledger';
import { idGen } from '../../helpers';

// Same numbers as the "Track a switch" wireframe.
const baseline = openingFromUnits([
  { instrumentId: 'VTI', quantity: d('120.5'), price: d('285.10') },
  { instrumentId: 'BND', quantity: d('150'), price: d('72.40') },
  { instrumentId: 'FUNDA', quantity: d('280'), price: d('18.20') },
]);

describe('openingFromUnits', () => {
  it('values each holding at the switch-date close', () => {
    expect(baseline.lines.map((l) => l.value.toString())).toEqual(['34354.55', '10860', '5096']);
    expect(baseline.total.toString()).toBe('50310.55');
  });

  it('rejects bad input', () => {
    expect(() => openingFromUnits([])).toThrow(OpeningError);
    expect(() => openingFromUnits([{ instrumentId: 'VTI', quantity: d('0'), price: d('1') }])).toThrow(OpeningError);
    expect(() =>
      openingFromUnits([
        { instrumentId: 'VTI', quantity: d('1'), price: d('1') },
        { instrumentId: 'VTI', quantity: d('1'), price: d('1') },
      ]),
    ).toThrow(/twice/);
  });

  it('allows a cash-only opening', () => {
    expect(openingFromUnits([], d('500')).total.toString()).toBe('500');
  });
});

describe('openingFromValue', () => {
  it('buys fractional units at the switch-date closes', () => {
    const o = openingFromValue(
      d('10000'),
      [{ instrumentId: 'VTI', pct: '60' }, { instrumentId: 'BND', pct: '40' }],
      new Map([['VTI', d('285.10')], ['BND', d('72.40')]]),
    );
    expect(o.lines.map((l) => l.quantity.toString())).toEqual(['21.045247', '55.248618']);
    expect(o.total.toString()).toBe('10000');
    expect(o.cash.lt('0.01')).toBe(true);
  });
});

describe('statement check and switch cost', () => {
  it('accepts small rounding gaps and flags big ones', () => {
    const ok = checkAgainstStatement(baseline.total, d('50300'));
    expect(ok.difference.toString()).toBe('10.55');
    expect(ok.differencePct.toFixed(4)).toBe('0.0002');
    expect(ok.withinTolerance).toBe(true);
    expect(checkAgainstStatement(baseline.total, d('45000')).withinTolerance).toBe(false);
  });

  it('measures what the switch cost on day one', () => {
    const { cost, costPct } = switchCost(baseline.total, d('49820'));
    expect(cost.toString()).toBe('490.55');
    expect(costPct?.toFixed(4)).toBe('0.0098');
  });
});

describe('openingTransactions', () => {
  it('creates OPENING lines whose replay reproduces the opening total', () => {
    let seq = 0;
    const opening = openingFromUnits([{ instrumentId: 'VTI', quantity: d('2'), price: d('100') }], d('7.5'));
    const txs = openingTransactions(opening, {
      portfolioId: 'pA',
      date: '2026-09-15',
      newId: idGen(),
      nextSeq: () => ++seq,
      now: '',
    });
    expect(txs.map((t) => t.type)).toEqual(['OPENING', 'DEPOSIT']);
    const state = replayLedger(txs);
    expect(state.netInvested.toString()).toBe('207.5');
    expect(state.cash.toString()).toBe('7.5');
  });
});
