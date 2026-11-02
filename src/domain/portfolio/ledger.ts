/**
 * Ledger replay — turns the list of transactions into the portfolio's state.
 *
 * Cost basis uses the AVERAGE COST method:
 *   BUY / OPENING: costBasis += quantity × price;  quantity += q
 *   SELL:          costBasis −= costBasis × (q / quantity);  quantity −= q
 * so a partial sell removes a proportional slice of the cost. Realized gain
 * on a sell = proceeds − removed cost.
 *
 *   REINVEST:      quantity += q, costBasis unchanged
 *     Units received WITHOUT new money (dividends/interest paid in units,
 *     bonus shares). They cost nothing, so they show up as gain — on the
 *     holding (value − costBasis) and on the portfolio (value − netInvested)
 *     alike. `amount` records their value on the day, kept as `income`.
 *
 * Cash:
 *   DEPOSIT +amount, WITHDRAW −amount, BUY −amount, SELL +amount, FEE −amount.
 *   OPENING and REINVEST move no cash.
 *
 * "Net invested" = total deposits − withdrawals + value of opening positions.
 * It's the money the user has put in, which the dashboard compares with
 * current value to show total gain.
 */

import { Dec } from '../money/decimal';
import type { Id, Transaction } from '../types';
import type { IsoDate } from '../calendar/dates';

export interface Position {
  instrumentId: Id;
  quantity: Dec;
  /** Total cost of the shares still held (average-cost method). */
  costBasis: Dec;
  firstDate: IsoDate;
}

export interface LedgerState {
  cash: Dec;
  positions: Map<Id, Position>;
  netInvested: Dec;
  realizedGain: Dec;
  feesPaid: Dec;
  /** Value (on the day received) of units received without new money. */
  income: Dec;
}

export class LedgerError extends Error {}

/** Stable order: by trade date, then insertion order. */
export function sortTransactions(txs: readonly Transaction[]): Transaction[] {
  return [...txs].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.seq - b.seq));
}

/**
 * Replays transactions (optionally only those on or before `asOf`).
 * Throws LedgerError if a sell exceeds the shares held — that would mean
 * corrupt data, and silently continuing would hide it.
 */
export function replayLedger(txs: readonly Transaction[], asOf?: IsoDate): LedgerState {
  const state = emptyLedgerState();
  for (const tx of sortTransactions(txs)) {
    if (asOf && tx.date > asOf) break;
    applyTransaction(state, tx);
  }
  return state;
}

export function emptyLedgerState(): LedgerState {
  return { cash: Dec.ZERO, positions: new Map(), netInvested: Dec.ZERO, realizedGain: Dec.ZERO, feesPaid: Dec.ZERO, income: Dec.ZERO };
}

/**
 * Applies ONE transaction to `state` in place. Callers must apply
 * transactions in ledger order (sortTransactions); used for incremental
 * replays such as the daily value history.
 */
export function applyTransaction(state: LedgerState, tx: Transaction): void {
  {
    const amount = Dec.from(tx.amount);

    switch (tx.type) {
      case 'DEPOSIT':
        state.cash = state.cash.add(amount);
        state.netInvested = state.netInvested.add(amount);
        break;
      case 'WITHDRAW':
        state.cash = state.cash.sub(amount);
        state.netInvested = state.netInvested.sub(amount);
        break;
      case 'FEE':
        state.cash = state.cash.sub(amount);
        state.feesPaid = state.feesPaid.add(amount);
        break;
      case 'BUY':
      case 'OPENING': {
        const { instrumentId, quantity } = requireTrade(tx);
        const pos = state.positions.get(instrumentId) ?? {
          instrumentId,
          quantity: Dec.ZERO,
          costBasis: Dec.ZERO,
          firstDate: tx.date,
        };
        pos.quantity = pos.quantity.add(quantity);
        pos.costBasis = pos.costBasis.add(amount);
        state.positions.set(instrumentId, pos);
        if (tx.type === 'BUY') state.cash = state.cash.sub(amount);
        else state.netInvested = state.netInvested.add(amount);
        break;
      }
      case 'REINVEST': {
        const { instrumentId, quantity } = requireTrade(tx);
        const pos = state.positions.get(instrumentId) ?? {
          instrumentId,
          quantity: Dec.ZERO,
          costBasis: Dec.ZERO,
          firstDate: tx.date,
        };
        pos.quantity = pos.quantity.add(quantity);
        state.positions.set(instrumentId, pos);
        state.income = state.income.add(amount);
        break;
      }
      case 'SELL': {
        const { instrumentId, quantity } = requireTrade(tx);
        const pos = state.positions.get(instrumentId);
        if (!pos || pos.quantity.lt(quantity)) {
          throw new LedgerError(`Sell of ${quantity} exceeds holding in ${instrumentId} on ${tx.date}`);
        }
        const removedCost = pos.costBasis.mul(quantity.div(pos.quantity));
        pos.quantity = pos.quantity.sub(quantity);
        pos.costBasis = pos.costBasis.sub(removedCost);
        state.realizedGain = state.realizedGain.add(amount.sub(removedCost));
        state.cash = state.cash.add(amount);
        if (pos.quantity.isZero()) state.positions.delete(instrumentId);
        break;
      }
      default: {
        const never: never = tx.type;
        throw new LedgerError(`Unknown transaction type ${String(never)}`);
      }
    }
  }
}

function requireTrade(tx: Transaction): { instrumentId: Id; quantity: Dec } {
  if (!tx.instrumentId || tx.quantity === undefined) {
    throw new LedgerError(`${tx.type} ${tx.id} needs instrumentId and quantity`);
  }
  const quantity = Dec.from(tx.quantity);
  if (!quantity.isPositive()) throw new LedgerError(`${tx.type} ${tx.id} quantity must be > 0`);
  return { instrumentId: tx.instrumentId, quantity };
}
