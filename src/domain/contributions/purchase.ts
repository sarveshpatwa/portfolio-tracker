/**
 * Purchase planner — splits one contribution across assets by target %.
 *
 * For each target:
 *   targetAmount = contribution × pct ÷ 100
 *
 * Fractional mode:
 *   quantity = floor(targetAmount ÷ price, fractionDigits)
 *   Rounding DOWN guarantees we never spend more than was allocated. The
 *   unspent sliver (always < 1 unit of the last digit × price) stays as cash.
 *
 * Whole-share mode:
 *   quantity = floor(targetAmount ÷ price)
 *   Leftover cash can be large (e.g. $300 aimed at a $586 share buys 0).
 *   Optional TOP-UP: repeatedly buy one more share of the asset that is
 *   furthest below its target within this contribution, measured in dollars:
 *     shortfall = targetAmount − amountSpentOnItSoFar
 *   Only assets that are still BELOW target (shortfall > 0) and affordable
 *   (price ≤ leftover) qualify; ties go to the asset listed first. It stops
 *   when nothing qualifies, so it never piles extra shares into an asset that
 *   already reached its share. Whatever remains stays as cash.
 *
 * leftoverCash = contribution − Σ cost. It is added to the portfolio's cash.
 */

import { Dec } from '../money/decimal';
import type { AllocationTarget, BuyMode, Id } from '../types';
import { validateAllocation } from './allocation';

export interface PurchaseLine {
  instrumentId: Id;
  pct: Dec;
  targetAmount: Dec;
  price: Dec;
  quantity: Dec;
  cost: Dec;
}

export interface PurchasePlan {
  amount: Dec;
  lines: PurchaseLine[];
  spent: Dec;
  leftoverCash: Dec;
}

export interface PurchaseOptions {
  amount: Dec;
  targets: readonly AllocationTarget[];
  prices: ReadonlyMap<Id, Dec>;
  mode: BuyMode;
  fractionDigits?: number;
  topUpWholeShares?: boolean;
}

export class PurchaseError extends Error {}

export function planPurchase(opts: PurchaseOptions): PurchasePlan {
  const { amount, targets, prices, mode } = opts;
  const fractionDigits = opts.fractionDigits ?? 6;

  if (!amount.isPositive()) throw new PurchaseError('Contribution amount must be more than $0.');
  const check = validateAllocation(targets);
  if (!check.ok) throw new PurchaseError('Allocation must be valid and total 100% before buying.');

  const lines: PurchaseLine[] = [];
  for (const t of targets) {
    const pct = Dec.from(t.pct);
    if (pct.isZero()) continue;
    const price = prices.get(t.instrumentId);
    if (!price || !price.isPositive()) {
      throw new PurchaseError(`No price available for ${t.instrumentId}.`);
    }
    const targetAmount = amount.mul(pct).div(Dec.HUNDRED);
    const rawQty = targetAmount.div(price);
    const quantity = mode === 'fractional' ? rawQty.floorTo(fractionDigits) : rawQty.floorTo(0);
    lines.push({ instrumentId: t.instrumentId, pct, targetAmount, price, quantity, cost: quantity.mul(price) });
  }

  let leftover = amount.sub(Dec.sum(lines.map((l) => l.cost)));

  if (mode === 'whole' && opts.topUpWholeShares) {
    // Each iteration buys one share, and leftover strictly decreases, so this terminates.
    for (;;) {
      let pick: PurchaseLine | undefined;
      let pickShortfall: Dec | undefined;
      for (const line of lines) {
        if (line.price.gt(leftover)) continue;
        const shortfall = line.targetAmount.sub(line.cost);
        if (!shortfall.isPositive()) continue;
        if (!pickShortfall || shortfall.gt(pickShortfall)) {
          pick = line;
          pickShortfall = shortfall;
        }
      }
      if (!pick) break;
      pick.quantity = pick.quantity.add(Dec.ONE);
      pick.cost = pick.quantity.mul(pick.price);
      leftover = leftover.sub(pick.price);
    }
  }

  const spent = amount.sub(leftover);
  return { amount, lines, spent, leftoverCash: leftover };
}
