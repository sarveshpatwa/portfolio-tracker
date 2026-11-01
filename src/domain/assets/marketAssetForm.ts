/**
 * Starting position for a market (ticker) asset.
 *
 * Units are optional. If entered:
 *  - purchase date defaults to today and can't be in the future;
 *  - cost per share defaults to the CLOSING PRICE on the purchase date (or the
 *    last trading day before it) from the downloaded daily history — so
 *    "I bought 10 VTI on Jan 6, 2025" needs no price lookup by hand.
 */

import { Dec } from '../money/decimal';
import { isIsoDate, type IsoDate } from '../calendar/dates';
import { priceOnOrBefore } from '../pricing/prices';
import type { PricePoint } from '../types';

export interface MarketStartInput {
  units: string;
  cost: string;
  date: string;
}

export type MarketStartErrors = Partial<Record<keyof MarketStartInput, string>>;

export type MarketStart = { quantity: Dec; costPerUnit: Dec; date: IsoDate; costFromHistory: boolean } | null;

export function parseMarketStart(
  input: MarketStartInput,
  today: IsoDate,
  history: readonly PricePoint[],
): { ok: true; value: MarketStart } | { ok: false; errors: MarketStartErrors } {
  const errors: MarketStartErrors = {};
  if (![input.units, input.cost, input.date].some((s) => s.trim())) return { ok: true, value: null };

  const quantity = Dec.tryParse(input.units);
  if (!quantity || !quantity.isPositive()) errors.units = 'Enter shares above 0, or clear the starting position.';

  const date = input.date.trim() || today;
  if (!isIsoDate(date)) errors.date = 'Enter a valid date.';
  else if (date > today) errors.date = 'The date can’t be in the future.';

  let costPerUnit: Dec | undefined;
  let costFromHistory = false;
  if (input.cost.trim()) {
    const c = Dec.tryParse(input.cost);
    if (!c || !c.isPositive()) errors.cost = 'Enter a cost above 0.';
    else costPerUnit = c;
  } else if (!errors.date) {
    const close = priceOnOrBefore(history, date);
    if (close) {
      costPerUnit = close.price;
      costFromHistory = true;
    } else {
      errors.cost = 'No price history for that date. Enter the cost per share.';
    }
  }

  if (Object.keys(errors).length > 0 || !quantity || !costPerUnit) return { ok: false, errors };
  return { ok: true, value: { quantity, costPerUnit, date, costFromHistory } };
}
