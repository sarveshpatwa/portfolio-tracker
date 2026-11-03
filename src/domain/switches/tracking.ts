/**
 * Tracking a switch: "what if I'd stayed in the old portfolio?"
 *
 * A switch links a BASELINE (the old portfolio, kept as it was on the switch
 * date) to the NEW portfolio the money moved to. Both are tracked from the
 * switch date.
 *
 * Switch check (shown on the Compare screen):
 *   difference    = newValue − baselineValue          (positive = the switch helped)
 *   differencePct = difference ÷ baselineValue
 *   Both values come from each portfolio's own ledger, so new money counts on
 *   both sides only when "mirror new money" is on (otherwise compare the
 *   time-weighted returns, which ignore new money).
 *
 * Optional costs of the new portfolio, shown as a what-if (not booked in the
 * ledger, so the ledgers keep matching your statements):
 *   afterFee = (newValue − oneTimeCost) × (1 − yearlyFeeRate)^(years since switch)
 *
 * Mirroring new money: every contribution to the new portfolio after the
 * switch date is copied into the baseline on the same date, same amount,
 * invested in the baseline's mix (its target allocation if it has one,
 * otherwise its holdings on the switch date). Mirrored entries get the id
 * `mirror:<switchId>:<contributionId>` so running on both devices and merging
 * backups never doubles them.
 */

import { Dec } from '../money/decimal';
import { daysBetween, type IsoDate } from '../calendar/dates';
import type { AllocationPlan, AllocationTarget, Id, Instrument, Portfolio, PortfolioSwitch, PricePoint, Transaction } from '../types';
import { planInEffect, validateAllocation } from '../contributions/allocation';
import { pricesForTrade, usableTargets } from '../contributions/execution';
import { planPurchase } from '../contributions/purchase';
import { contributionTransactions } from '../contributions/transactions';
import type { DayValue } from '../portfolio/history';
import { twr } from '../portfolio/history';

export const mirrorContributionId = (switchId: Id, contributionId: Id) => `mirror:${switchId}:${contributionId}`;

export interface SwitchSummary {
  switchDate: IsoDate;
  asOf: IsoDate;
  baselineStart: number;
  newStart: number;
  baselineNow: number;
  newNow: number;
  difference: number;
  differencePct: number | null;
  /** Time-weighted returns since the switch (new money ignored). */
  baselineReturn: number;
  newReturn: number;
  /** New portfolio value after the optional yearly fee, if one is set. */
  newAfterFee?: number;
  /** Lines from the switch date on, for the small chart. */
  baselineSeries: DayValue[];
  newSeries: DayValue[];
}

export function summariseSwitch(sw: PortfolioSwitch, baseline: readonly DayValue[], next: readonly DayValue[], annualFeePct?: string): SwitchSummary | null {
  const from = (s: readonly DayValue[]) => s.filter((d) => d.date >= sw.switchDate);
  const b = from(baseline);
  const n = from(next);
  if (b.length === 0 || n.length === 0) return null;
  const bNow = b[b.length - 1]!;
  const nNow = n[n.length - 1]!;
  const difference = nNow.value - bNow.value;
  const out: SwitchSummary = {
    switchDate: sw.switchDate,
    asOf: nNow.date > bNow.date ? nNow.date : bNow.date,
    baselineStart: b[0]!.value,
    newStart: n[0]!.value,
    baselineNow: bNow.value,
    newNow: nNow.value,
    difference,
    differencePct: bNow.value > 0 ? difference / bNow.value : null,
    baselineReturn: twr(b),
    newReturn: twr(n),
    baselineSeries: b,
    newSeries: n,
  };
  const fee = annualFeePct ? Number(annualFeePct) / 100 : 0;
  const oneTime = sw.oneTimeCost ? Number(sw.oneTimeCost) : 0;
  if (fee > 0 || oneTime > 0) out.newAfterFee = (nNow.value - oneTime) * Math.pow(1 - fee, daysBetween(sw.switchDate, out.asOf) / 365.25);
  return out;
}

/** The baseline's mix for mirrored money: its plan in effect, else its holdings on the switch date. */
export function baselineTargets(
  sw: PortfolioSwitch,
  plans: readonly AllocationPlan[],
  baselineTxs: readonly Transaction[],
  assetIds: ReadonlySet<Id>,
  date: IsoDate,
): AllocationTarget[] | null {
  const plan = planInEffect(plans, date);
  const usable = usableTargets(plan, assetIds);
  if (usable.ok) return usable.targets;
  const openings = baselineTxs.filter((t) => t.type === 'OPENING' && t.date <= sw.switchDate && t.instrumentId && assetIds.has(t.instrumentId));
  const total = openings.reduce((a, t) => a.add(t.amount), Dec.ZERO);
  if (!total.isPositive()) return null;
  const byId = new Map<Id, Dec>();
  for (const t of openings) byId.set(t.instrumentId!, (byId.get(t.instrumentId!) ?? Dec.ZERO).add(t.amount));
  // Percentages to 6 dp; the last one takes the rounding remainder so they total exactly 100.
  const ids = [...byId.keys()];
  let left = Dec.from(100);
  const targets = ids.map((id, i) => {
    const pct = i === ids.length - 1 ? left : byId.get(id)!.div(total).mul(100).floorTo(6);
    left = left.sub(pct);
    return { instrumentId: id, pct: pct.toString() };
  });
  return validateAllocation(targets).ok ? targets : null;
}

export interface MirrorContext {
  sw: PortfolioSwitch;
  baseline: Portfolio;
  newTxs: readonly Transaction[];
  baselineTxs: readonly Transaction[];
  baselinePlans: readonly AllocationPlan[];
  baselineAssetIds: ReadonlySet<Id>;
  instruments: ReadonlyMap<Id, Instrument>;
  points: readonly PricePoint[];
  /** Latest trading day with final closes. */
  throughTradeDate: IsoDate;
  nextSeq: () => number;
  now: string;
}

export interface MirrorRun {
  transactions: Transaction[];
  mirrored: number;
  waiting: number;
  blocked?: string;
}

/** New baseline entries that mirror contributions to the new portfolio. */
export function mirrorContributions(ctx: MirrorContext): MirrorRun {
  const out: MirrorRun = { transactions: [], mirrored: 0, waiting: 0 };
  if (!ctx.sw.mirrorContributions) return out;
  const done = new Set(ctx.baselineTxs.map((t) => t.contributionId).filter(Boolean));
  const deposits = ctx.newTxs
    .filter((t) => t.type === 'DEPOSIT' && t.contributionId && !t.contributionId.startsWith('mirror:') && t.date > ctx.sw.switchDate)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.seq - b.seq));
  for (const dep of deposits) {
    const id = mirrorContributionId(ctx.sw.id, dep.contributionId!);
    if (done.has(id)) continue;
    if (dep.date > ctx.throughTradeDate) {
      out.waiting++;
      continue;
    }
    const targets = baselineTargets(ctx.sw, ctx.baselinePlans, ctx.baselineTxs, ctx.baselineAssetIds, dep.date);
    if (!targets) {
      out.blocked = 'The old portfolio has no holdings or target allocation to mirror new money into.';
      return out;
    }
    const tp = pricesForTrade(targets.map((t) => t.instrumentId), ctx.instruments, ctx.points, dep.date, 'close');
    if (tp.missing.some((m) => m.reason === 'not-downloaded-yet')) {
      out.waiting++;
      continue;
    }
    if (tp.missing.length) {
      out.blocked = `No price on ${dep.date} for an asset in the old portfolio.`;
      return out;
    }
    const amount = Dec.from(dep.amount);
    const purchase = planPurchase({
      amount,
      targets,
      prices: tp.prices,
      mode: ctx.baseline.buyMode,
      fractionDigits: ctx.baseline.fractionDigits,
      topUpWholeShares: ctx.baseline.topUpWholeShares,
    });
    out.transactions.push(
      ...contributionTransactions(
        purchase,
        { portfolioId: ctx.baseline.id, date: dep.date, newId: () => '', nextSeq: ctx.nextSeq, now: ctx.now },
        { contributionId: id, note: `Mirrored ${amount.toFixed(2)} (switch)` },
      ),
    );
    out.mirrored++;
  }
  return out;
}
