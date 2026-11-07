/**
 * Allocation plan versions, recurring rules, buy settings and contribution
 * entries.
 *
 * Every write that adds ledger entries replays the portfolio's whole ledger
 * first; if the result wouldn't add up, nothing is saved.
 */

import { describeIssue, validateAllocation } from '../../domain/contributions/allocation';
import { LedgerError, replayLedger } from '../../domain/portfolio/ledger';
import { todayLocal, type IsoDate } from '../../domain/calendar/dates';
import type { Dec } from '../../domain/money/decimal';
import type { AllocationPlan, AllocationTarget, BuyMode, ContributionRule, Deletion, Frequency, Portfolio, Transaction } from '../../domain/types';
import { getDb, S } from '../db/schema';
import { newId } from '../ids';
import { ValidationError } from './errors';

async function assertLedgerOk(portfolioId: string, added: readonly Transaction[]): Promise<void> {
  const db = await getDb();
  const existing = await db.getAllByIndex<Transaction>(S.transactions, 'portfolioId', portfolioId);
  try {
    replayLedger([...existing, ...added]);
  } catch (err) {
    if (err instanceof LedgerError) throw new ValidationError('These entries would make the ledger inconsistent, so nothing was saved.');
    throw err;
  }
}

export const contributionRepo = {
  // --- allocation plans ----------------------------------------------------
  async plans(portfolioId: string): Promise<AllocationPlan[]> {
    const rows = await (await getDb()).getAllByIndex<AllocationPlan>(S.allocationPlans, 'portfolioId', portfolioId);
    return rows.sort((a, b) => a.version - b.version || a.createdAt.localeCompare(b.createdAt));
  },

  async allPlans(): Promise<AllocationPlan[]> {
    return (await getDb()).getAll<AllocationPlan>(S.allocationPlans);
  },

  /** Saves the targets as a new version effective from today. Past contributions keep the version they used. */
  async saveAllocation(portfolioId: string, targets: AllocationTarget[], nameOf: (id: string) => string = (id) => id): Promise<AllocationPlan> {
    const cleaned = targets.map((t) => ({ instrumentId: t.instrumentId, pct: t.pct.trim() || '0' }));
    const check = validateAllocation(cleaned);
    if (!check.ok) throw new ValidationError(check.issues.map((i) => describeIssue(i, nameOf)).join(' '));
    const existing = await this.plans(portfolioId);
    const plan: AllocationPlan = {
      id: newId(),
      portfolioId,
      version: Math.max(0, ...existing.map((p) => p.version)) + 1,
      effectiveFrom: todayLocal(),
      targets: cleaned,
      createdAt: new Date().toISOString(),
    };
    await (await getDb()).write([S.allocationPlans], ({ put }) => put(S.allocationPlans, plan));
    return plan;
  },

  // --- buy settings ----------------------------------------------------------
  async setBuySettings(portfolio: Portfolio, buyMode: BuyMode, topUpWholeShares: boolean): Promise<void> {
    const updated: Portfolio = { ...portfolio, buyMode, topUpWholeShares, updatedAt: new Date().toISOString() };
    await (await getDb()).write([S.portfolios], ({ put }) => put(S.portfolios, updated));
  },

  // --- recurring rules -------------------------------------------------------
  async rules(portfolioId: string): Promise<ContributionRule[]> {
    const rows = await (await getDb()).getAllByIndex<ContributionRule>(S.contributionRules, 'portfolioId', portfolioId);
    return rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  },

  async allRules(): Promise<ContributionRule[]> {
    return (await getDb()).getAll<ContributionRule>(S.contributionRules);
  },

  async createRule(portfolioId: string, v: { amount: Dec; frequency: Frequency; startDate: IsoDate; endDate?: IsoDate }): Promise<ContributionRule> {
    const now = new Date().toISOString();
    const rule: ContributionRule = {
      id: newId(),
      portfolioId,
      amount: v.amount.toString(),
      frequency: v.frequency,
      startDate: v.startDate,
      ...(v.endDate ? { endDate: v.endDate } : {}),
      paused: false,
      createdAt: now,
      updatedAt: now,
    };
    await (await getDb()).write([S.contributionRules], ({ put }) => put(S.contributionRules, rule));
    return rule;
  },

  /**
   * Pausing skips dates while paused: on resume, the schedule continues from
   * TODAY instead of back-filling the paused period.
   */
  async setPaused(rule: ContributionRule, paused: boolean, today: IsoDate = todayLocal()): Promise<void> {
    const updated: ContributionRule = { ...rule, paused, updatedAt: new Date().toISOString() };
    // Resuming: mark everything up to today as handled, so the paused period isn't back-filled.
    const started = today >= rule.startDate;
    if (!paused && started && (!rule.lastScheduledDate || rule.lastScheduledDate < today)) updated.lastScheduledDate = today;
    await (await getDb()).write([S.contributionRules], ({ put }) => put(S.contributionRules, updated));
  },

  /** Changes a rule's amount. Buys already made keep their amount; the next ones use the new one. */
  async setAmount(rule: ContributionRule, amount: string): Promise<void> {
    const updated: ContributionRule = { ...rule, amount, updatedAt: new Date().toISOString() };
    await (await getDb()).write([S.contributionRules], ({ put }) => put(S.contributionRules, updated));
  },

  /** Deletes the rule. Contributions it already made stay in the ledger. */
  async deleteRule(rule: ContributionRule): Promise<void> {
    const tombstone: Deletion = { id: rule.id, store: S.contributionRules, deletedAt: new Date().toISOString() };
    await (await getDb()).write([S.contributionRules, S.deletions], ({ del, put }) => {
      del(S.contributionRules, rule.id);
      put(S.deletions, tombstone);
    });
  },

  /** Records executed recurring contributions and advances the rule, atomically. */
  async recordRecurring(rule: ContributionRule, txs: readonly Transaction[], lastScheduledDate: IsoDate): Promise<void> {
    await assertLedgerOk(rule.portfolioId, txs);
    const updated: ContributionRule = { ...rule, lastScheduledDate, updatedAt: new Date().toISOString() };
    await (await getDb()).write([S.transactions, S.contributionRules], ({ put }) => {
      for (const t of txs) put(S.transactions, t);
      put(S.contributionRules, updated);
    });
  },

  async addContribution(portfolioId: string, txs: readonly Transaction[]): Promise<void> {
    await assertLedgerOk(portfolioId, txs);
    await (await getDb()).write([S.transactions], ({ put }) => {
      for (const t of txs) put(S.transactions, t);
    });
  },
};

