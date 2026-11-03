/**
 * Portfolio persistence. Deleting a portfolio also deletes everything that
 * belongs to it (ledger, assets, allocation plans, recurring rules, switch
 * links) in one atomic transaction, so no orphaned records are left behind.
 * A tombstone is kept so a backup merge removes it on the other device too.
 */

import type { SignalSettings, Deletion, Portfolio } from '../../domain/types';
import { getDb, S } from '../db/schema';
import { newId } from '../ids';
import { ValidationError } from './errors';

export { ValidationError } from './errors';

export const MAX_NAME_LENGTH = 60;

export function validatePortfolioName(raw: string, existing: readonly Portfolio[], selfId?: string): string {
  const name = raw.trim().replace(/\s+/g, ' ');
  if (!name) throw new ValidationError('Enter a name.');
  if (name.length > MAX_NAME_LENGTH) throw new ValidationError(`Keep the name under ${MAX_NAME_LENGTH} characters.`);
  const clash = existing.find((p) => p.id !== selfId && p.name.toLowerCase() === name.toLowerCase());
  if (clash) throw new ValidationError(`You already have a portfolio called “${clash.name}”.`);
  return name;
}

export const portfolioRepo = {
  async list(): Promise<Portfolio[]> {
    const db = await getDb();
    const all = await db.getAll<Portfolio>(S.portfolios);
    return all.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  },

  async get(id: string): Promise<Portfolio | undefined> {
    return (await getDb()).get<Portfolio>(S.portfolios, id);
  },

  async create(rawName: string): Promise<Portfolio> {
    const db = await getDb();
    const name = validatePortfolioName(rawName, await this.list());
    const now = new Date().toISOString();
    const portfolio: Portfolio = {
      id: newId(),
      name,
      createdAt: now,
      updatedAt: now,
      buyMode: 'fractional',
      fractionDigits: 6,
      topUpWholeShares: false,
    };
    await db.write([S.portfolios], ({ put }) => put(S.portfolios, portfolio));
    return portfolio;
  },

  async rename(id: string, rawName: string): Promise<Portfolio> {
    const db = await getDb();
    const current = await this.get(id);
    if (!current) throw new ValidationError('That portfolio no longer exists.');
    const name = validatePortfolioName(rawName, await this.list(), id);
    const updated: Portfolio = { ...current, name, updatedAt: new Date().toISOString() };
    await db.write([S.portfolios], ({ put }) => put(S.portfolios, updated));
    return updated;
  },

  /** Saves this portfolio's signal thresholds (undefined = back to defaults). */
  async setSignalSettings(id: string, settings: SignalSettings | undefined): Promise<void> {
    const db = await getDb();
    const current = await this.get(id);
    if (!current) throw new ValidationError('That portfolio no longer exists.');
    const { signalSettings: _old, ...rest } = current;
    const updated: Portfolio = { ...rest, ...(settings ? { signalSettings: settings } : {}), updatedAt: new Date().toISOString() };
    await db.write([S.portfolios], ({ put }) => put(S.portfolios, updated));
  },

  async remove(id: string): Promise<void> {
    const db = await getDb();
    const tombstone: Deletion = { id, store: S.portfolios, deletedAt: new Date().toISOString() };
    await db.write(
      [S.portfolios, S.transactions, S.portfolioAssets, S.allocationPlans, S.contributionRules, S.switches, S.deletions],
      ({ put, del, deleteByIndex }) => {
        del(S.portfolios, id);
        deleteByIndex(S.transactions, 'portfolioId', id);
        deleteByIndex(S.portfolioAssets, 'portfolioId', id);
        deleteByIndex(S.allocationPlans, 'portfolioId', id);
        deleteByIndex(S.contributionRules, 'portfolioId', id);
        deleteByIndex(S.switches, 'fromPortfolioId', id);
        deleteByIndex(S.switches, 'toPortfolioId', id);
        put(S.deletions, tombstone);
      },
    );
  },
};
