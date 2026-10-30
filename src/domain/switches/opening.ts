/**
 * Opening positions for portfolios that start on a past date — used by
 * "Track a switch" for both the baseline (old) and the new portfolio.
 *
 * Two ways to describe what was held on the switch date:
 *
 *  1. Units held (preferred, exact):
 *       value_i = units_i × close_i(switchDate)
 *       total   = Σ value_i + cash
 *
 *  2. Total value + allocation %:
 *       Buys fractional units at that day's closes using the same planner as
 *       contributions (purchase.ts), so units_i = floor(total × pct_i ÷ close_i, 6).
 *       The sub-cent remainder becomes opening cash.
 *
 * Each holding becomes an OPENING transaction whose cost basis is its value on
 * the switch date, so all gains are measured FROM the switch.
 *
 * Statement check:
 *   difference    = computedTotal − statementValue
 *   differencePct = difference ÷ statementValue
 *   A gap beyond ±1% is flagged — usually a wrong unit count, or a fund
 *   quoted in another currency.
 *
 * Cost of the switch (shown as "lost on the switch day"):
 *   switchCost    = baselineValue − newValue        (positive = money lost)
 *   switchCostPct = switchCost ÷ baselineValue
 */

import { Dec } from '../money/decimal';
import type { AllocationTarget, Id, Transaction } from '../types';
import { planPurchase } from '../contributions/purchase';
import type { TxContext } from '../contributions/transactions';

export interface OpeningLine {
  instrumentId: Id;
  quantity: Dec;
  price: Dec;
  value: Dec;
}

export interface OpeningPositions {
  lines: OpeningLine[];
  cash: Dec;
  total: Dec;
}

export class OpeningError extends Error {}

export function openingFromUnits(
  holdings: readonly { instrumentId: Id; quantity: Dec; price: Dec }[],
  cash: Dec = Dec.ZERO,
): OpeningPositions {
  if (cash.isNegative()) throw new OpeningError('Cash can’t be negative.');
  const seen = new Set<Id>();
  const lines = holdings.map((h) => {
    if (seen.has(h.instrumentId)) throw new OpeningError(`${h.instrumentId} is listed twice.`);
    seen.add(h.instrumentId);
    if (!h.quantity.isPositive()) throw new OpeningError(`Units for ${h.instrumentId} must be more than 0.`);
    if (!h.price.isPositive()) throw new OpeningError(`Price for ${h.instrumentId} must be more than 0.`);
    return { instrumentId: h.instrumentId, quantity: h.quantity, price: h.price, value: h.quantity.mul(h.price) };
  });
  if (lines.length === 0 && cash.isZero()) throw new OpeningError('Enter at least one holding or some cash.');
  return { lines, cash, total: Dec.sum(lines.map((l) => l.value)).add(cash) };
}

export function openingFromValue(
  totalValue: Dec,
  targets: readonly AllocationTarget[],
  prices: ReadonlyMap<Id, Dec>,
  fractionDigits = 6,
): OpeningPositions {
  const plan = planPurchase({ amount: totalValue, targets, prices, mode: 'fractional', fractionDigits });
  const lines = plan.lines
    .filter((l) => l.quantity.isPositive())
    .map((l) => ({ instrumentId: l.instrumentId, quantity: l.quantity, price: l.price, value: l.cost }));
  return { lines, cash: plan.leftoverCash, total: totalValue };
}

export interface StatementCheck {
  difference: Dec;
  differencePct: Dec;
  withinTolerance: boolean;
}

const STATEMENT_TOLERANCE = Dec.from('0.01'); // 1%

export function checkAgainstStatement(computedTotal: Dec, statementValue: Dec): StatementCheck {
  if (!statementValue.isPositive()) throw new OpeningError('Statement value must be more than 0.');
  const difference = computedTotal.sub(statementValue);
  const differencePct = difference.div(statementValue);
  return { difference, differencePct, withinTolerance: differencePct.abs().lte(STATEMENT_TOLERANCE) };
}

export function switchCost(baselineValue: Dec, newValue: Dec): { cost: Dec; costPct: Dec | null } {
  const cost = baselineValue.sub(newValue);
  return { cost, costPct: baselineValue.isZero() ? null : cost.div(baselineValue) };
}

/** OPENING transactions for each holding plus a DEPOSIT for any opening cash. */
export function openingTransactions(opening: OpeningPositions, ctx: TxContext, note = 'Opening position'): Transaction[] {
  const txs: Transaction[] = opening.lines.map((l) => ({
    id: ctx.newId(),
    seq: ctx.nextSeq(),
    portfolioId: ctx.portfolioId,
    type: 'OPENING',
    date: ctx.date,
    instrumentId: l.instrumentId,
    quantity: l.quantity.toString(),
    price: l.price.toString(),
    amount: l.value.toString(),
    note,
    createdAt: ctx.now,
  }));
  if (opening.cash.isPositive()) {
    txs.push({
      id: ctx.newId(),
      seq: ctx.nextSeq(),
      portfolioId: ctx.portfolioId,
      type: 'DEPOSIT',
      date: ctx.date,
      amount: opening.cash.toString(),
      note: 'Opening cash',
      createdAt: ctx.now,
    });
  }
  return txs;
}
