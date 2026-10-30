/**
 * "Update holding" — change a manual asset's price, its units, or both, on a date.
 *
 * Units can be entered two ways:
 *   - Add units:   unitsChange = entered amount (must be > 0)
 *   - New total:   unitsChange = enteredTotal − unitsHeldNow   (from a statement)
 *
 * Where added units came from decides how they count:
 *   - 'money'  → DEPOSIT (units × price) + BUY. The money counts as invested,
 *                so it doesn't show as gain.
 *   - 'earned' → REINVEST. Dividends/interest paid in units or bonus shares:
 *                no new money, so their value counts as gain. This is how a
 *                fixed-price ($1.00) holding shows its growth.
 * A lower new total records a SELL of the difference at the entered price;
 * the proceeds go to the portfolio's cash.
 *
 * The price is saved as a new price point only when it differs from the
 * current price, so a units-only update doesn't clutter the price history.
 */

import { Dec } from '../money/decimal';
import { isIsoDate, type IsoDate } from '../calendar/dates';
import type { Id, PricePoint, Transaction } from '../types';
import type { TxContext } from '../contributions/transactions';

export type UnitsMode = 'add' | 'total';
export type UnitsSource = 'money' | 'earned';

export interface HoldingUpdateInput {
  date: string;
  price: string;
  unitsMode: UnitsMode;
  units: string;
  source: UnitsSource | '';
}

export interface HoldingUpdate {
  date: IsoDate;
  price: Dec;
  priceChanged: boolean;
  /** Positive = units added, negative = units removed, zero = price only. */
  unitsChange: Dec;
  source?: UnitsSource;
  unitsAfter: Dec;
}

export type HoldingUpdateErrors = Partial<Record<keyof HoldingUpdateInput | 'form', string>>;

export function parseHoldingUpdate(
  input: HoldingUpdateInput,
  ctx: { unitsHeld: Dec; currentPrice?: Dec; today: IsoDate },
): { ok: true; value: HoldingUpdate } | { ok: false; errors: HoldingUpdateErrors } {
  const errors: HoldingUpdateErrors = {};

  const date = input.date.trim();
  if (!isIsoDate(date)) errors.date = 'Enter a valid date.';
  else if (date > ctx.today) errors.date = 'The date can’t be in the future.';

  const price = Dec.tryParse(input.price);
  if (!price || !price.isPositive()) errors.price = 'Enter a price above 0.';

  let unitsChange = Dec.ZERO;
  const unitsText = input.units.trim();
  if (unitsText) {
    const n = Dec.tryParse(unitsText);
    if (input.unitsMode === 'add') {
      if (!n || !n.isPositive()) errors.units = 'Enter units above 0. To reduce units, use “New total”.';
      else unitsChange = n;
    } else if (!n || n.isNegative()) {
      errors.units = 'Enter the total units held (0 or more).';
    } else {
      unitsChange = n.sub(ctx.unitsHeld);
    }
  }

  let source: UnitsSource | undefined;
  if (unitsChange.isPositive()) {
    if (input.source === 'money' || input.source === 'earned') source = input.source;
    else errors.source = 'Choose where the new units came from.';
  }

  const priceChanged = !!price && (!ctx.currentPrice || !price.eq(ctx.currentPrice));
  if (Object.keys(errors).length === 0 && !priceChanged && unitsChange.isZero()) {
    errors.form = 'Nothing to save — change the price or the units.';
  }

  if (Object.keys(errors).length > 0 || !price) return { ok: false, errors };
  return {
    ok: true,
    value: { date, price, priceChanged, unitsChange, ...(source ? { source } : {}), unitsAfter: ctx.unitsHeld.add(unitsChange) },
  };
}

/** The price point and ledger entries that record an update. */
export function holdingUpdateRecords(
  u: HoldingUpdate,
  instrumentId: Id,
  ctx: TxContext,
): { pricePoint?: PricePoint; transactions: Transaction[] } {
  const pricePoint: PricePoint | undefined = u.priceChanged
    ? { instrumentId, date: u.date, close: u.price.toString(), source: 'manual', updatedAt: ctx.now }
    : undefined;

  const base = { portfolioId: ctx.portfolioId, date: u.date, instrumentId, price: u.price.toString(), createdAt: ctx.now };
  const qty = u.unitsChange.abs();
  const value = qty.mul(u.price).toString();
  const transactions: Transaction[] = [];

  if (u.unitsChange.isPositive() && u.source === 'money') {
    const contributionId = ctx.newId();
    transactions.push(
      { id: ctx.newId(), seq: ctx.nextSeq(), portfolioId: ctx.portfolioId, type: 'DEPOSIT', date: u.date, amount: value, contributionId, note: 'Money for added units', createdAt: ctx.now },
      { ...base, id: ctx.newId(), seq: ctx.nextSeq(), type: 'BUY', quantity: qty.toString(), amount: value, contributionId },
    );
  } else if (u.unitsChange.isPositive()) {
    transactions.push({ ...base, id: ctx.newId(), seq: ctx.nextSeq(), type: 'REINVEST', quantity: qty.toString(), amount: value, note: 'Earned / reinvested units' });
  } else if (u.unitsChange.isNegative()) {
    transactions.push({ ...base, id: ctx.newId(), seq: ctx.nextSeq(), type: 'SELL', quantity: qty.toString(), amount: value, note: 'Units reduced' });
  }
  return { ...(pricePoint ? { pricePoint } : {}), transactions };
}
