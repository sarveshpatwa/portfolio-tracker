import { Dec, type DecInput } from './decimal';

/** "$1,234.56" or "−$1,234.56" (uses a true minus sign for legibility). */
export function formatUsd(value: DecInput, dp = 2): string {
  const v = Dec.from(value);
  const [whole, frac] = v.abs().toFixed(dp).split('.');
  const grouped = (whole ?? '0').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const body = frac ? `$${grouped}.${frac}` : `$${grouped}`;
  return v.isNegative() && !v.roundTo(dp).isZero() ? `−${body}` : body;
}

/** Signed amount for gains: "+$12.00", "−$3.40", "$0.00". */
export function formatSignedUsd(value: DecInput, dp = 2): string {
  const v = Dec.from(value);
  if (v.roundTo(dp).isZero()) return formatUsd(0, dp);
  return v.isNegative() ? formatUsd(v, dp) : `+${formatUsd(v, dp)}`;
}

/** Percentage from a ratio: 0.176 → "+17.6%". Pass signed=false for weights. */
export function formatPct(ratio: DecInput, dp = 1, signed = true): string {
  const pct = Dec.from(ratio).mul(100);
  const text = `${pct.abs().toFixed(dp)}%`;
  if (pct.roundTo(dp).isZero()) return `${Dec.ZERO.toFixed(dp)}%`;
  if (pct.isNegative()) return `−${text}`;
  return signed ? `+${text}` : text;
}

/** Share quantity without trailing zeros, up to `dp` places, thousands grouped: "19.8743", "5,250". */
export function formatQty(value: DecInput, dp = 6): string {
  const [whole = '0', frac] = Dec.from(value).roundTo(dp).toString().split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return frac ? `${grouped}.${frac}` : grouped;
}
