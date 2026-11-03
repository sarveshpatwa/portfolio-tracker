/**
 * Price indicators used by signals and the risk profile. All pure functions
 * on plain numbers (returns and ratios don't need exact decimals).
 *
 *  - Simple return:        r_t = P_t / P_{t−1} − 1
 *  - Volatility:           sample standard deviation of daily returns × √252
 *                          (252 ≈ trading days a year), shown as a % per year.
 *  - Moving average (SMA): mean of the last N closes.
 *  - Max drawdown:         the largest fall from a running peak:
 *                          min over t of (V_t / max_{s≤t} V_s − 1)   (≤ 0)
 */

export const TRADING_DAYS_PER_YEAR = 252;

export function returns(values: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < values.length; i++) {
    const prev = values[i - 1]!;
    if (prev > 0) out.push(values[i]! / prev - 1);
  }
  return out;
}

/** Sample standard deviation (n − 1). 0 for fewer than 2 values. */
export function stdev(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const v = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(v);
}

/** Annualised volatility of daily returns. */
export function annualVolatility(dailyReturns: readonly number[]): number {
  return stdev(dailyReturns) * Math.sqrt(TRADING_DAYS_PER_YEAR);
}

export function sma(values: readonly number[], n: number): number | null {
  if (n <= 0 || values.length < n) return null;
  let sum = 0;
  for (let i = values.length - n; i < values.length; i++) sum += values[i]!;
  return sum / n;
}

/** Largest peak-to-trough fall (≤ 0) and when it happened. */
export function maxDrawdown(values: readonly number[]): { drawdown: number; peakIndex: number; troughIndex: number } {
  let peak = -Infinity;
  let peakIdx = 0;
  let best = { drawdown: 0, peakIndex: 0, troughIndex: 0 };
  values.forEach((v, i) => {
    if (v > peak) {
      peak = v;
      peakIdx = i;
    }
    if (peak > 0) {
      const dd = v / peak - 1;
      if (dd < best.drawdown) best = { drawdown: dd, peakIndex: peakIdx, troughIndex: i };
    }
  });
  return best;
}
