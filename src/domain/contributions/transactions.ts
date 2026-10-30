/**
 * Turns a purchase plan into ledger transactions: one DEPOSIT for the
 * contribution followed by one BUY per asset bought. Lines that buy zero
 * shares (possible in whole-share mode) produce no BUY; their money stays as
 * cash because only actual costs are subtracted.
 */

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

export function contributionTransactions(
  plan: PurchasePlan,
  ctx: TxContext,
  meta: { allocationPlanId?: Id; scheduledDate?: IsoDate; note?: string } = {},
): Transaction[] {
  const contributionId = ctx.newId();
  const base = {
    portfolioId: ctx.portfolioId,
    date: ctx.date,
    contributionId,
    allocationPlanId: meta.allocationPlanId,
    scheduledDate: meta.scheduledDate,
    createdAt: ctx.now,
  };

  const txs: Transaction[] = [
    { ...base, id: ctx.newId(), seq: ctx.nextSeq(), type: 'DEPOSIT', amount: plan.amount.toString(), note: meta.note },
  ];
  for (const line of plan.lines) {
    if (line.quantity.isZero()) continue;
    txs.push({
      ...base,
      id: ctx.newId(),
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
