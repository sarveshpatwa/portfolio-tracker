/**
 * Allocation breakdown by asset class.
 *
 *   classValue  = Σ value of holdings in the class
 *   classWeight = classValue ÷ totalValue   (cash is its own "Cash" row)
 *
 * Rows are sorted largest first; zero-value classes are dropped.
 */

import { Dec } from '../money/decimal';
import type { AssetClass, Id } from '../types';
import type { PortfolioValue } from './valuation';

export interface ClassSlice {
  key: AssetClass | 'cash';
  value: Dec;
  weight: Dec;
}

export function breakdownByClass(valuation: PortfolioValue, classOf: (instrumentId: Id) => AssetClass): ClassSlice[] {
  const totals = new Map<AssetClass | 'cash', Dec>();
  for (const h of valuation.holdings) {
    const key = classOf(h.instrumentId);
    totals.set(key, (totals.get(key) ?? Dec.ZERO).add(h.value));
  }
  if (!valuation.cash.isZero()) totals.set('cash', valuation.cash);

  const total = valuation.totalValue;
  return [...totals]
    .filter(([, v]) => !v.isZero())
    .map(([key, value]) => ({ key, value, weight: total.isZero() ? Dec.ZERO : value.div(total) }))
    .sort((a, b) => b.value.cmp(a.value));
}
