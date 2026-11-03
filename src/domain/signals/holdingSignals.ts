/**
 * Holding signals: plain-language warnings about one holding. Information
 * only — the app never buys or sells because of them.
 *
 * Each signal has a severity:
 *   'warning' — worth acting on or at least looking at now,
 *   'watch'   — worth keeping an eye on.
 *
 * Signals (thresholds per portfolio, see DEFAULT_SIGNAL_SETTINGS):
 *  1. Decline:        price fell ≥ declinePct over the last declineDays calendar
 *                     days (last price vs the price on/before that day).
 *                     Warning at 2× the threshold, otherwise watch.
 *  2. Off its high:   price ≥ drawdownPct below its highest price of the last
 *                     365 days → warning.
 *  3. Below average:  last close below the movingAverageDays-day average by
 *                     more than 2% → watch. Needs daily prices.
 *  4. Volatility:     20-day volatility ≥ volatilityMultiple × the volatility
 *                     of the preceding (up to) 230 days → watch. Needs daily
 *                     prices and at least 80 of them.
 *  5. Concentration:  holding is ≥ concentrationPct of the portfolio → watch;
 *                     ≥ max(50%, 2 × threshold) → warning.
 *  6. Stop-loss:      price at or below your alert level → warning; within 5%
 *                     above it → watch.
 *
 * "Daily prices" = at least 20 prices in the last 45 calendar days (market
 * tickers and Vanguard-linked funds). Manually priced assets, updated every week
 * or two, only get the signals that make sense for sparse prices (1, 2, 5, 6).
 */

import { addDays, type IsoDate } from '../calendar/dates';
import type { SignalSettings } from '../types';
import { annualVolatility, returns, sma } from './indicators';

export const DEFAULT_SIGNAL_SETTINGS: SignalSettings = {
  declinePct: 10,
  declineDays: 30,
  drawdownPct: 20,
  concentrationPct: 30,
  volatilityMultiple: 2,
  movingAverageDays: 50,
};

export type SignalKind = 'decline' | 'drawdown' | 'below-average' | 'volatility' | 'concentration' | 'stop-loss';
export type Severity = 'warning' | 'watch';

export interface Signal {
  kind: SignalKind;
  severity: Severity;
  title: string;
  reason: string;
}

export interface PricedDay {
  date: IsoDate;
  close: number;
}

export interface HoldingSignalInput {
  /** Price history, any order; one price per date. */
  prices: readonly PricedDay[];
  /** Share of the portfolio's total value, 0–1. */
  weight: number;
  stopLoss?: number;
  settings?: Partial<SignalSettings>;
}

const dateFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const day = (iso: IsoDate) => dateFmt.format(new Date(`${iso}T00:00:00Z`));
const pct = (x: number, d = 1) => `${(x * 100).toFixed(d)}%`;
const usd = (x: number) => `$${x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: x < 10 ? 4 : 2 })}`;

export function settingsWithDefaults(s?: Partial<SignalSettings>): SignalSettings {
  return { ...DEFAULT_SIGNAL_SETTINGS, ...(s ?? {}) };
}

export function hasDailyPrices(prices: readonly PricedDay[]): boolean {
  if (prices.length < 20) return false;
  const last = prices.reduce((m, p) => (p.date > m ? p.date : m), prices[0]!.date);
  const from = addDays(last, -45);
  return prices.filter((p) => p.date > from).length >= 20;
}

export function holdingSignals(input: HoldingSignalInput): Signal[] {
  const s = settingsWithDefaults(input.settings);
  const sorted = [...input.prices].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const out: Signal[] = [];
  const last = sorted[sorted.length - 1];

  if (last) {
    // 1. Decline over N days
    const fromDate = addDays(last.date, -s.declineDays);
    let base: PricedDay | undefined;
    for (const p of sorted) if (p.date <= fromDate) base = p;
    if (base && base.close > 0 && s.declinePct > 0) {
      const change = last.close / base.close - 1;
      if (change <= -s.declinePct / 100) {
        out.push({
          kind: 'decline',
          severity: change <= (-2 * s.declinePct) / 100 ? 'warning' : 'watch',
          title: `Down ${pct(-change)} in ${s.declineDays} days`,
          reason: `Price fell from ${usd(base.close)} to ${usd(last.close)} since ${day(base.date)} (your alert: ${s.declinePct}% in ${s.declineDays} days).`,
        });
      }
    }

    // 2. Off its 52-week high
    const yearAgo = addDays(last.date, -365);
    const high = sorted.filter((p) => p.date >= yearAgo).reduce((m, p) => (p.close > m.close ? p : m), last);
    if (high.close > 0 && s.drawdownPct > 0) {
      const dd = last.close / high.close - 1;
      if (dd <= -s.drawdownPct / 100) {
        out.push({
          kind: 'drawdown',
          severity: 'warning',
          title: `${pct(-dd)} below its high`,
          reason: `The highest price in the last year was ${usd(high.close)} on ${day(high.date)}; it’s ${usd(last.close)} now (your alert: ${s.drawdownPct}% below the high).`,
        });
      }
    }

    // 6. Stop-loss level
    if (input.stopLoss !== undefined && input.stopLoss > 0) {
      if (last.close <= input.stopLoss) {
        out.push({
          kind: 'stop-loss',
          severity: 'warning',
          title: 'At or below your alert price',
          reason: `Price ${usd(last.close)} is at or below the ${usd(input.stopLoss)} level you set. The app doesn’t sell — decide what you want to do.`,
        });
      } else if (last.close <= input.stopLoss * 1.05) {
        out.push({
          kind: 'stop-loss',
          severity: 'watch',
          title: 'Near your alert price',
          reason: `Price ${usd(last.close)} is within 5% of the ${usd(input.stopLoss)} level you set.`,
        });
      }
    }
  }

  const daily = hasDailyPrices(sorted);
  const closes = sorted.map((p) => p.close);

  // 3. Below its moving average
  if (daily && last && s.movingAverageDays > 0) {
    const avg = sma(closes, s.movingAverageDays);
    if (avg !== null && last.close < avg * 0.98) {
      out.push({
        kind: 'below-average',
        severity: 'watch',
        title: `Below its ${s.movingAverageDays}-day average`,
        reason: `Price ${usd(last.close)} is ${pct(1 - last.close / avg)} under its ${s.movingAverageDays}-day average of ${usd(avg)} — often a sign the trend has turned down.`,
      });
    }
  }

  // 4. Volatility spike
  if (daily && closes.length >= 80 && s.volatilityMultiple > 0) {
    const r = returns(closes);
    const recent = annualVolatility(r.slice(-20));
    const usual = annualVolatility(r.slice(Math.max(0, r.length - 250), -20));
    if (usual > 0 && recent >= s.volatilityMultiple * usual) {
      out.push({
        kind: 'volatility',
        severity: 'watch',
        title: 'Swinging much more than usual',
        reason: `Over the last 20 trading days its price moved about ${pct(recent, 0)} a year (volatility), vs ${pct(usual, 0)} usually — ${(recent / usual).toFixed(1)}× normal.`,
      });
    }
  }

  // 5. Concentration
  if (s.concentrationPct > 0 && input.weight >= s.concentrationPct / 100) {
    const warnAt = Math.max(0.5, (2 * s.concentrationPct) / 100);
    out.push({
      kind: 'concentration',
      severity: input.weight >= warnAt ? 'warning' : 'watch',
      title: `${pct(input.weight, 0)} of the portfolio`,
      reason: `A large share in one holding means its ups and downs drive the whole portfolio (your alert: ${s.concentrationPct}%).`,
    });
  }

  return out.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'warning' ? -1 : 1));
}

/** Validates the thresholds form. */
export function parseSignalSettings(input: Record<keyof SignalSettings, string>): { ok: true; value: SignalSettings } | { ok: false; errors: Partial<Record<keyof SignalSettings, string>> } {
  const errors: Partial<Record<keyof SignalSettings, string>> = {};
  const num = (k: keyof SignalSettings, min: number, max: number, int = false) => {
    const v = Number(input[k].trim());
    if (input[k].trim() === '' || !Number.isFinite(v) || v < min || v > max || (int && !Number.isInteger(v))) {
      errors[k] = `Enter ${int ? 'a whole number' : 'a number'} from ${min} to ${max}.`;
      return 0;
    }
    return v;
  };
  const value: SignalSettings = {
    declinePct: num('declinePct', 0, 90),
    declineDays: num('declineDays', 1, 365, true),
    drawdownPct: num('drawdownPct', 0, 90),
    concentrationPct: num('concentrationPct', 0, 100),
    volatilityMultiple: num('volatilityMultiple', 0, 10),
    movingAverageDays: num('movingAverageDays', 0, 250, true),
  };
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value };
}
