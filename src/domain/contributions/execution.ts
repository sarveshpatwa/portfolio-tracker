/**
 * Executing contributions: which prices to buy at, and running recurring
 * rules (including catch-up of dates missed while the app was closed).
 *
 * Prices used
 * -----------
 *  - One-time, today:   the latest price of each asset (live during market
 *                       hours, otherwise the last close / manual price).
 *  - One-time, past:    the closing price on or before that date (market
 *                       assets use final closes only; manual assets use the
 *                       last price you entered on or before it).
 *  - Recurring:         the FINAL close of the trade date (a weekend/holiday
 *                       schedule date trades on the next trading day). A buy
 *                       waits until that close exists — i.e. after 16:15 ET,
 *                       or once the history top-up has downloaded it.
 *                       Manual assets use the last price on or before it.
 *
 * Recurring rules are processed in date order. If one date can't run yet
 * (close not downloaded) the rule pauses there and retries on the next tick.
 * If it can never run as configured (a manual asset has no price that early,
 * or the allocation is invalid) the rule reports the reason and stops.
 */

import { Dec } from '../money/decimal';
import type { IsoDate } from '../calendar/dates';
import { priceOnOrBefore } from '../pricing/prices';
import { lastFinalClose } from '../market/history';
import type { AllocationPlan, AllocationTarget, ContributionRule, Id, Instrument, Portfolio, PricePoint, Transaction } from '../types';
import { planInEffect, validateAllocation } from './allocation';
import { planPurchase, type PurchasePlan } from './purchase';
import { dueContributions } from './schedule';
import { contributionTransactions } from './transactions';

export type PriceMode = 'latest' | 'asOf' | 'close';

export type MissingPrice = { instrumentId: Id; reason: 'not-downloaded-yet' | 'no-price' };

export interface TradePrices {
  prices: Map<Id, Dec>;
  /** Date of the price used per asset (for showing "closes of Oct 30"). */
  dates: Map<Id, IsoDate>;
  missing: MissingPrice[];
}

export function pricesForTrade(
  instrumentIds: readonly Id[],
  instruments: ReadonlyMap<Id, Instrument>,
  points: readonly PricePoint[],
  date: IsoDate,
  mode: PriceMode,
): TradePrices {
  const prices = new Map<Id, Dec>();
  const dates = new Map<Id, IsoDate>();
  const missing: MissingPrice[] = [];
  for (const id of instrumentIds) {
    const own = points.filter((p) => p.instrumentId === id);
    const market = instruments.get(id)?.priceSource === 'market';
    let found: { price: Dec; date: IsoDate } | undefined;
    if (mode === 'latest' || !market) {
      found = priceOnOrBefore(own, date);
    } else {
      const finals = own.filter((p) => !p.intraday);
      const exact = mode === 'close' ? finals.find((p) => p.date === date) : undefined;
      if (exact) found = { price: Dec.from(exact.close), date: exact.date };
      else {
        const last = lastFinalClose(own);
        if (!last || last < date) {
          // History doesn't reach that date yet (or the close isn't final).
          if (mode === 'close') missing.push({ instrumentId: id, reason: 'not-downloaded-yet' });
          else found = priceOnOrBefore(finals, date);
        } else {
          // History goes past the date but has no bar on it: the market was closed
          // that day (use the previous close) — or history starts after it (no price, ever).
          found = priceOnOrBefore(finals, date);
          if (!found) missing.push({ instrumentId: id, reason: 'no-price' });
        }
      }
    }
    if (found) {
      prices.set(id, found.price);
      dates.set(id, found.date);
    } else if (!missing.some((m) => m.instrumentId === id)) {
      missing.push({ instrumentId: id, reason: market && mode !== 'latest' ? 'not-downloaded-yet' : 'no-price' });
    }
  }
  return { prices, dates, missing };
}

/** Targets restricted to assets still in the portfolio, and whether they still total 100%. */
export function usableTargets(plan: AllocationPlan | undefined, assetIds: ReadonlySet<Id>): { targets: AllocationTarget[]; ok: boolean } {
  if (!plan) return { targets: [], ok: false };
  const targets = plan.targets.filter((t) => assetIds.has(t.instrumentId) && Dec.from(t.pct).isPositive());
  return { targets, ok: targets.length > 0 && validateAllocation(targets).ok };
}

export interface RecurringRun {
  executed: { scheduledDate: IsoDate; tradeDate: IsoDate; plan: PurchasePlan; transactions: Transaction[] }[];
  /** New `lastScheduledDate` for the rule (undefined = unchanged). */
  lastScheduledDate?: IsoDate;
  /** Why the rule stopped early, if it did. */
  waiting?: { scheduledDate: IsoDate; reason: 'not-downloaded-yet' };
  blocked?: { scheduledDate: IsoDate; message: string };
}

export interface RecurringContext {
  rule: ContributionRule;
  portfolio: Portfolio;
  plans: readonly AllocationPlan[];
  assetIds: ReadonlySet<Id>;
  instruments: ReadonlyMap<Id, Instrument>;
  points: readonly PricePoint[];
  /** Latest trading day with a final close (latestCompletedTradingDay). */
  throughTradeDate: IsoDate;
  nextSeq: () => number;
  now: string;
  nameOf: (id: Id) => string;
}

/** Deterministic id for one scheduled run of a rule (same on every device). */
export const recurringContributionId = (ruleId: Id, scheduledDate: IsoDate) => `rc:${ruleId}:${scheduledDate}`;

export function runRecurring(ctx: RecurringContext): RecurringRun {
  const { rule, portfolio } = ctx;
  const out: RecurringRun = { executed: [] };
  const amount = Dec.from(rule.amount);
  const earliest = [...ctx.plans].sort((a, b) =>
    a.effectiveFrom !== b.effectiveFrom ? (a.effectiveFrom < b.effectiveFrom ? -1 : 1) : a.version - b.version,
  )[0];

  for (const due of dueContributions(rule, ctx.throughTradeDate)) {
    const plan = planInEffect(ctx.plans, due.scheduledDate) ?? earliest;
    const { targets, ok } = usableTargets(plan, ctx.assetIds);
    if (!plan || !ok) {
      out.blocked = { scheduledDate: due.scheduledDate, message: 'Set a target allocation that totals 100% to run recurring contributions.' };
      return out;
    }
    const tp = pricesForTrade(
      targets.map((t) => t.instrumentId),
      ctx.instruments,
      ctx.points,
      due.tradeDate,
      'close',
    );
    const notYet = tp.missing.find((m) => m.reason === 'not-downloaded-yet');
    if (notYet) {
      out.waiting = { scheduledDate: due.scheduledDate, reason: 'not-downloaded-yet' };
      return out;
    }
    if (tp.missing.length > 0) {
      const names = tp.missing.map((m) => ctx.nameOf(m.instrumentId)).join(', ');
      out.blocked = {
        scheduledDate: due.scheduledDate,
        message: `No price for ${names} on or before ${due.tradeDate}. Add an earlier price or move the start date later.`,
      };
      return out;
    }
    const purchase = planPurchase({
      amount,
      targets,
      prices: tp.prices,
      mode: portfolio.buyMode,
      fractionDigits: portfolio.fractionDigits,
      topUpWholeShares: portfolio.topUpWholeShares,
    });
    const transactions = contributionTransactions(
      purchase,
      { portfolioId: portfolio.id, date: due.tradeDate, newId: () => '', nextSeq: ctx.nextSeq, now: ctx.now },
      {
        allocationPlanId: plan.id,
        scheduledDate: due.scheduledDate,
        contributionId: recurringContributionId(rule.id, due.scheduledDate),
        note: `Recurring ${amount.toFixed(2)} ${rule.frequency}`,
      },
    );
    out.executed.push({ scheduledDate: due.scheduledDate, tradeDate: due.tradeDate, plan: purchase, transactions });
    out.lastScheduledDate = due.scheduledDate;
  }
  return out;
}
