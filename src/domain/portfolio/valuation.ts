/**
 * Values a ledger state at a set of prices.
 *
 * For each holding:
 *   value       = quantity × price
 *   gain ($)    = value − costBasis
 *   gain (%)    = gain ÷ costBasis              (undefined when costBasis is 0)
 *   weight      = value ÷ total portfolio value (cash included in the total)
 *
 * Portfolio:
 *   totalValue  = Σ holding values + cash
 *   totalGain   = totalValue − netInvested
 *   totalGain % = totalGain ÷ netInvested
 *
 * totalGain % is a simple "money in vs value now" return. It is NOT a
 * time-weighted return; the comparison feature uses TWR so that the timing of
 * contributions doesn't distort rankings.
 */

import { Dec } from '../money/decimal';
import type { Id } from '../types';
import type { LedgerState } from './ledger';

export interface HoldingValue {
  instrumentId: Id;
  quantity: Dec;
  price: Dec | null; // null = no price known yet
  value: Dec;
  costBasis: Dec;
  gain: Dec;
  gainPct: Dec | null;
  weight: Dec;
}

export interface PortfolioValue {
  holdings: HoldingValue[];
  cash: Dec;
  cashWeight: Dec;
  totalValue: Dec;
  netInvested: Dec;
  totalGain: Dec;
  totalGainPct: Dec | null;
  /** Holdings that had no price; their value counts as 0 until a price arrives. */
  missingPrices: Id[];
}

export function valuePortfolio(state: LedgerState, prices: ReadonlyMap<Id, Dec>): PortfolioValue {
  const missingPrices: Id[] = [];
  const rows = [...state.positions.values()].map((pos) => {
    const price = prices.get(pos.instrumentId) ?? null;
    if (!price) missingPrices.push(pos.instrumentId);
    const value = price ? pos.quantity.mul(price) : Dec.ZERO;
    return { pos, price, value };
  });

  const totalValue = Dec.sum(rows.map((r) => r.value)).add(state.cash);
  const weightOf = (v: Dec) => (totalValue.isZero() ? Dec.ZERO : v.div(totalValue));

  const holdings: HoldingValue[] = rows.map(({ pos, price, value }) => {
    const gain = price ? value.sub(pos.costBasis) : Dec.ZERO;
    return {
      instrumentId: pos.instrumentId,
      quantity: pos.quantity,
      price,
      value,
      costBasis: pos.costBasis,
      gain,
      gainPct: price && !pos.costBasis.isZero() ? gain.div(pos.costBasis) : null,
      weight: weightOf(value),
    };
  });

  const totalGain = totalValue.sub(state.netInvested);
  return {
    holdings,
    cash: state.cash,
    cashWeight: weightOf(state.cash),
    totalValue,
    netInvested: state.netInvested,
    totalGain,
    totalGainPct: state.netInvested.isZero() ? null : totalGain.div(state.netInvested),
    missingPrices,
  };
}
