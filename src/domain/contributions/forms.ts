/**
 * Validation for the contribution forms (one-time and recurring).
 *
 * Recurring rules may start in the PAST: that back-fills every scheduled date
 * since then at the historical closing prices — a quick way to simulate
 * "what if I had invested $500 a month since January?".
 */

import { Dec } from '../money/decimal';
import { isIsoDate, type IsoDate } from '../calendar/dates';
import type { Frequency } from '../types';

export const FREQUENCIES: { value: Frequency; label: string }[] = [
  { value: 'monthly', label: 'Monthly' },
  { value: 'biweekly', label: 'Every 2 weeks' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'quarterly', label: 'Quarterly' },
];

export const MAX_CONTRIBUTION = Dec.from('100000000'); // $100M sanity cap

function amountError(text: string): { amount?: Dec; error?: string } {
  const v = Dec.tryParse(text);
  if (!v || !v.isPositive()) return { error: 'Enter an amount above $0.' };
  if (v.gt(MAX_CONTRIBUTION)) return { error: 'That amount is too large.' };
  if (!v.eq(v.roundTo(2))) return { error: 'Use at most 2 decimal places (cents).' };
  return { amount: v };
}

export function parseOneTime(
  input: { amount: string; date: string },
  today: IsoDate,
): { ok: true; amount: Dec; date: IsoDate } | { ok: false; errors: { amount?: string; date?: string } } {
  const errors: { amount?: string; date?: string } = {};
  const { amount, error } = amountError(input.amount);
  if (error) errors.amount = error;
  const date = input.date.trim() || today;
  if (!isIsoDate(date)) errors.date = 'Enter a valid date.';
  else if (date > today) errors.date = 'The date can’t be in the future.';
  return amount && Object.keys(errors).length === 0 ? { ok: true, amount, date } : { ok: false, errors };
}

export interface RuleInput {
  amount: string;
  frequency: Frequency;
  startDate: string;
  endDate: string;
}

export function parseRule(
  input: RuleInput,
): { ok: true; value: { amount: Dec; frequency: Frequency; startDate: IsoDate; endDate?: IsoDate } } | { ok: false; errors: Partial<Record<keyof RuleInput, string>> } {
  const errors: Partial<Record<keyof RuleInput, string>> = {};
  const { amount, error } = amountError(input.amount);
  if (error) errors.amount = error;
  if (!FREQUENCIES.some((f) => f.value === input.frequency)) errors.frequency = 'Choose how often.';
  const startDate = input.startDate.trim();
  if (!isIsoDate(startDate)) errors.startDate = 'Enter a start date.';
  const endDate = input.endDate.trim();
  if (endDate) {
    if (!isIsoDate(endDate)) errors.endDate = 'Enter a valid end date, or leave it empty.';
    else if (isIsoDate(startDate) && endDate < startDate) errors.endDate = 'The end date must be after the start date.';
  }
  if (!amount || Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: { amount, frequency: input.frequency, startDate, ...(endDate ? { endDate } : {}) } };
}
