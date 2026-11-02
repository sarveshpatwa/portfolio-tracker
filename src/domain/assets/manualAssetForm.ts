/**
 * Validation for "Add asset → Manual price".
 *
 * Takes the raw text the user typed and returns either clean typed values or
 * a message per field, so the form can show every problem next to its input.
 *
 * Starting position is optional. If units are entered:
 *  - cost per unit defaults to the current price when left blank,
 *  - purchase date defaults to the price date when left blank,
 *  - the purchase date can't be after today.
 *
 * When the purchase date is earlier than the price date, the cost per unit is
 * also recorded as a price point on the purchase date, so the value history
 * starts at what was paid instead of jumping straight to today's price.
 */

import { Dec } from '../money/decimal';
import { isIsoDate, type IsoDate } from '../calendar/dates';
import type { AssetClass } from '../types';
import { parsePriceLink, type PriceLink } from '../pricing/priceLink';

export interface ManualAssetFormInput {
  name: string;
  assetClass: AssetClass;
  price: string;
  priceDate: string;
  reminderDays: string; // "", "7", "14"
  startQuantity: string;
  startCost: string;
  startDate: string;
  /** Optional Vanguard page link or fund number. */
  priceLink?: string;
}

export interface ManualAssetValues {
  name: string;
  assetClass: AssetClass;
  price: Dec;
  priceDate: IsoDate;
  reminderDays?: number;
  starting?: { quantity: Dec; costPerUnit: Dec; date: IsoDate };
  /** Optional: fetch daily prices from the fund's Vanguard page data. */
  priceLink?: PriceLink;
  /** The price was fetched from the price link (stored as a 'link' price, not a typed one). */
  priceFetched?: boolean;
}

export type FieldErrors = Partial<Record<keyof ManualAssetFormInput, string>>;

export type ParseResult = { ok: true; value: ManualAssetValues } | { ok: false; errors: FieldErrors };

export const MAX_ASSET_NAME_LENGTH = 60;

export function parseManualAssetForm(
  input: ManualAssetFormInput,
  today: IsoDate,
  existingNamesInPortfolio: readonly string[] = [],
): ParseResult {
  const errors: FieldErrors = {};

  const name = input.name.trim().replace(/\s+/g, ' ');
  if (!name) errors.name = 'Enter a name.';
  else if (name.length > MAX_ASSET_NAME_LENGTH) errors.name = `Keep the name under ${MAX_ASSET_NAME_LENGTH} characters.`;
  else if (existingNamesInPortfolio.some((n) => n.toLowerCase() === name.toLowerCase())) {
    errors.name = 'This portfolio already has an asset with that name.';
  }

  const price = positive(input.price);
  if (!price) errors.price = 'Enter a price above 0.';

  const priceDate = input.priceDate.trim();
  const priceDateError = dateError(priceDate, today);
  if (priceDateError) errors.priceDate = priceDateError;

  let reminderDays: number | undefined;
  if (input.reminderDays.trim()) {
    const n = Number(input.reminderDays);
    if (!Number.isInteger(n) || n <= 0) errors.reminderDays = 'Choose a reminder interval.';
    else reminderDays = n;
  }

  let starting: ManualAssetValues['starting'];
  const hasStart = [input.startQuantity, input.startCost, input.startDate].some((s) => s.trim() !== '');
  if (hasStart) {
    const quantity = positive(input.startQuantity);
    if (!quantity) errors.startQuantity = 'Enter units above 0, or clear the starting position.';

    const costPerUnit = input.startCost.trim() ? positive(input.startCost) : price;
    if (input.startCost.trim() && !costPerUnit) errors.startCost = 'Enter a cost above 0.';

    const date = input.startDate.trim() || priceDate;
    const startDateError = input.startDate.trim() ? dateError(date, today) : undefined;
    if (startDateError) errors.startDate = startDateError;

    if (quantity && costPerUnit && !startDateError && isIsoDate(date)) starting = { quantity, costPerUnit, date };
  }

  let priceLink: PriceLink | undefined;
  if (input.priceLink?.trim()) {
    const r = parsePriceLink(input.priceLink);
    if (r.ok) priceLink = r.link;
    else errors.priceLink = r.error;
  }

  if (Object.keys(errors).length > 0 || !price) return { ok: false, errors };
  return {
    ok: true,
    value: {
      name,
      assetClass: input.assetClass,
      price,
      priceDate,
      ...(reminderDays ? { reminderDays } : {}),
      ...(starting ? { starting } : {}),
      ...(priceLink ? { priceLink } : {}),
    },
  };
}

/** Validates a manual price update. */
export function parsePriceUpdate(priceText: string, dateText: string, today: IsoDate): { ok: true; price: Dec; date: IsoDate } | { ok: false; errors: { price?: string; date?: string } } {
  const price = positive(priceText);
  const date = dateText.trim();
  const errors: { price?: string; date?: string } = {};
  if (!price) errors.price = 'Enter a price above 0.';
  const de = dateError(date, today);
  if (de) errors.date = de;
  return price && !de ? { ok: true, price, date } : { ok: false, errors };
}

function positive(text: string): Dec | undefined {
  const v = Dec.tryParse(text);
  return v && v.isPositive() ? v : undefined;
}

function dateError(date: string, today: IsoDate): string | undefined {
  if (!isIsoDate(date)) return 'Enter a valid date.';
  if (date > today) return 'The date can’t be in the future.';
  return undefined;
}
