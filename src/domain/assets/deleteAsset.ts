/**
 * Deleting an asset from a portfolio (e.g. added by mistake) erases it as if
 * it had never been added:
 *
 *  - every ledger entry for that asset in the portfolio is removed
 *    (OPENING, BUY, SELL, REINVEST);
 *  - a DEPOSIT that only funded this asset (same contributionId, and every
 *    other entry in that group is for this asset) is removed too, so the money
 *    doesn't linger as cash and "invested";
 *  - a DEPOSIT shared with other assets (a split contribution) is kept, so
 *    this asset's share of it becomes cash.
 *
 * This differs from SELLING units (Update → New total), which keeps history.
 */

import { Dec } from '../money/decimal';
import type { Id, Transaction } from '../types';
import { replayLedger } from '../portfolio/ledger';

export interface AssetDeletionPlan {
  removeIds: Id[];
  remaining: Transaction[];
  /** Cash that stays behind from shared contributions. */
  keptCash: Dec;
  /** True when the remaining ledger would have negative cash (e.g. this asset's sale funded other buys). */
  cashGoesNegative: boolean;
}

export function planAssetDeletion(txs: readonly Transaction[], instrumentId: Id): AssetDeletionPlan {
  const remove = new Set<Id>();
  for (const t of txs) if (t.instrumentId === instrumentId) remove.add(t.id);

  // Group entries by contribution to find deposits that only funded this asset.
  const groups = new Map<Id, Transaction[]>();
  for (const t of txs) {
    if (!t.contributionId) continue;
    const g = groups.get(t.contributionId);
    if (g) g.push(t);
    else groups.set(t.contributionId, [t]);
  }
  let keptCash = Dec.ZERO;
  for (const group of groups.values()) {
    const trades = group.filter((t) => t.type !== 'DEPOSIT');
    const ours = trades.filter((t) => t.instrumentId === instrumentId);
    if (ours.length === 0) continue;
    if (ours.length === trades.length) {
      for (const t of group) if (t.type === 'DEPOSIT') remove.add(t.id);
    } else {
      keptCash = keptCash.add(Dec.sum(ours.filter((t) => t.type === 'BUY').map((t) => t.amount)));
    }
  }

  const remaining = txs.filter((t) => !remove.has(t.id));
  const cashGoesNegative = replayLedger(remaining).cash.isNegative();
  return { removeIds: [...remove], remaining, keptCash, cashGoesNegative };
}
