/**
 * Turns a purchase plan into ledger transactions: one DEPOSIT for the new
 * money, followed by one BUY per asset bought. Lines that buy zero shares
 * (possible in whole-share mode) produce no BUY; their money stays as cash
 * because only actual costs are subtracted.
 *
 * The deposit can be smaller than the amount invested: "also invest the cash
 * already in the portfolio" deposits the new money only, while the buys spend
 * new money + existing cash.
 *
 * Recurring contributions pass a fixed `contributionId` (rule id + scheduled
 * date) so every device that runs the same scheduled buy creates the SAME ids,
 * and a backup merge keeps a single copy instead of two.
 */

import type { Dec } from '../money/decimal';
import type { IsoDate } from '../calendar/dates';
import type { Id, Transaction } from '../types';
import type { PurchasePlan } from './purchase';

export interface TxContext {
  portfolioId: Id;
  date: IsoDate;
  newId: () => Id;
  nextSeq: () => number;
  now: string;
}

export interface ContributionMeta {
  allocationPlanId?: Id;
  scheduledDate?: IsoDate;
  note?: string;
  /** New money deposited; defaults to the full plan amount. */
  depositAmount?: Dec;
  /** Fixed id for the whole contribution — entry ids are derived from it (deterministic). */
  contributionId?: Id;
}

export function contributionTransactions(plan: PurchasePlan, ctx: TxContext, meta: ContributionMeta = {}): Transaction[] {
  const fixed = meta.contributionId;
  const contributionId = fixed ?? ctx.newId();
  const idFor = (suffix: string) => (fixed ? `${fixed}:${suffix}` : ctx.newId());
  const base = {
    portfolioId: ctx.portfolioId,
    date: ctx.date,
    contributionId,
    ...(meta.allocationPlanId ? { allocationPlanId: meta.allocationPlanId } : {}),
    ...(meta.scheduledDate ? { scheduledDate: meta.scheduledDate } : {}),
    createdAt: ctx.now,
  };
  const deposit = meta.depositAmount ?? plan.amount;

  const txs: Transaction[] = [];
  if (deposit.isPositive()) {
    txs.push({
      ...base,
      id: idFor('deposit'),
      seq: ctx.nextSeq(),
      type: 'DEPOSIT',
      amount: deposit.toString(),
      ...(meta.note ? { note: meta.note } : {}),
    });
  }
  for (const line of plan.lines) {
    if (line.quantity.isZero()) continue;
    txs.push({
      ...base,
      id: idFor(`buy:${line.instrumentId}`),
      seq: ctx.nextSeq(),
      type: 'BUY',
      instrumentId: line.instrumentId,
      quantity: line.quantity.toString(),
      price: line.price.toString(),
      amount: line.cost.toString(),
    });
  }
  return txs;
}
