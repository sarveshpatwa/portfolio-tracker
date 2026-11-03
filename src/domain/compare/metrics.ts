/**
 * Performance metrics for a value series (equal-money backtest or a
 * time-weighted index — both are "value of $1 over time" lines).
 *
 *  - Total return  = V_end / V_start − 1
 *  - Yearly (CAGR) = (1 + total)^(365.25 / calendar days) − 1, only with ≥ 90 days
 *  - Volatility    = stdev of daily returns × √252 (see signals/indicators.ts)
 *  - Largest drop  = maximum drawdown (worst fall from a running peak)
 *  - Sharpe ratio  = (CAGR − risk-free rate) / volatility
 *      "return earned per unit of risk taken"; higher is better. The risk-free
 *      rate is a fixed assumption (RISK_FREE_RATE ≈ US T-bills), shown in the UI.
 */

import { daysBetween, type IsoDate } from '../calendar/dates';
import { annualVolatility, maxDrawdown, returns } from '../signals/indicators';
import { MIN_DAYS_FOR_CAGR } from '../portfolio/history';

export const RISK_FREE_RATE = 0.04;

export interface DatedValue {
  date: IsoDate;
  value: number;
}

export interface Metrics {
  start: IsoDate;
  end: IsoDate;
  startValue: number;
  endValue: number;
  totalReturn: number;
  cagr: number | null;
  volatility: number | null;
  maxDrawdown: number;
  sharpe: number | null;
}

export function metricsOf(series: readonly DatedValue[], riskFree = RISK_FREE_RATE): Metrics | null {
  if (series.length < 2 || series[0]!.value <= 0) return null;
  const first = series[0]!;
  const last = series[series.length - 1]!;
  const totalReturn = last.value / first.value - 1;
  const days = daysBetween(first.date, last.date);
  const cagr = days >= MIN_DAYS_FOR_CAGR && totalReturn > -1 ? Math.pow(1 + totalReturn, 365.25 / days) - 1 : null;
  const r = returns(series.map((p) => p.value));
  const volatility = r.length >= 20 ? annualVolatility(r) : null;
  const sharpe = cagr !== null && volatility !== null && volatility > 0 ? (cagr - riskFree) / volatility : null;
  return {
    start: first.date,
    end: last.date,
    startValue: first.value,
    endValue: last.value,
    totalReturn,
    cagr,
    volatility,
    maxDrawdown: maxDrawdown(series.map((p) => p.value)).drawdown,
    sharpe,
  };
}
