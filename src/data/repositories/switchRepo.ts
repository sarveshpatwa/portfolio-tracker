/**
 * Switch links ("what if I'd stayed in the old portfolio?").
 *
 * Creating a switch writes, in ONE atomic transaction: the PortfolioSwitch
 * record, any opening positions entered for either portfolio (OPENING entries
 * dated the switch date), and both portfolios' start date (+ the optional
 * yearly fee on the new one). Each ledger is replayed first; if that fails,
 * nothing is saved.
 *
 * Deleting a switch removes only the link (and leaves a tombstone for backup
 * merges); both portfolios and their ledgers stay as they are.
 */

import type { Deletion, Portfolio, PortfolioSwitch, PricePoint, Transaction } from '../../domain/types';
import { LedgerError, replayLedger } from '../../domain/portfolio/ledger';
import { getDb, S } from '../db/schema';
import { newId } from '../ids';
import { ValidationError } from './errors';

export interface NewSwitch {
  switchDate: string;
  fromPortfolioId: string;
  toPortfolioId: string;
  mirrorContributions: boolean;
  fromStatementValue?: string;
  toStatementValue?: string;
  oneTimeCost?: string;
  /** Yearly fee % on the new portfolio (what-if only). */
  annualFeePct?: string;
  /** Opening entries to add (already built for the right portfolio). */
  openings: Transaction[];
  /** Prices typed for manual assets on the switch date. */
  pricePoints?: PricePoint[];
}

export const switchRepo = {
  async list(): Promise<PortfolioSwitch[]> {
    const rows = await (await getDb()).getAll<PortfolioSwitch>(S.switches);
    return rows.sort((a, b) => b.switchDate.localeCompare(a.switchDate));
  },

  async create(input: NewSwitch): Promise<PortfolioSwitch> {
    if (input.fromPortfolioId === input.toPortfolioId) throw new ValidationError('Choose two different portfolios.');
    const db = await getDb();
    const now = new Date().toISOString();
    const [from, to] = await Promise.all([
      db.get<Portfolio>(S.portfolios, input.fromPortfolioId),
      db.get<Portfolio>(S.portfolios, input.toPortfolioId),
    ]);
    if (!from || !to) throw new ValidationError('One of the portfolios no longer exists.');
    for (const p of [from, to]) {
      const existing = await db.getAllByIndex<Transaction>(S.transactions, 'portfolioId', p.id);
      try {
        replayLedger([...existing, ...input.openings.filter((t) => t.portfolioId === p.id)]);
      } catch (err) {
        if (err instanceof LedgerError) throw new ValidationError(`The ledger of “${p.name}” doesn’t add up with these openings.`);
        throw err;
      }
    }
    const sw: PortfolioSwitch = {
      id: newId(),
      switchDate: input.switchDate,
      fromPortfolioId: from.id,
      toPortfolioId: to.id,
      freezeBaseline: true,
      mirrorContributions: input.mirrorContributions,
      ...(input.fromStatementValue ? { fromStatementValue: input.fromStatementValue } : {}),
      ...(input.toStatementValue ? { toStatementValue: input.toStatementValue } : {}),
      ...(input.oneTimeCost ? { oneTimeCost: input.oneTimeCost } : {}),
      createdAt: now,
      updatedAt: now,
    };
    const { annualFeePct: _fee, ...toRest } = to;
    const updatedTo: Portfolio = {
      ...toRest,
      ...(input.annualFeePct ? { annualFeePct: input.annualFeePct } : {}),
      startDate: to.startDate && to.startDate < input.switchDate ? to.startDate : input.switchDate,
      updatedAt: now,
    };
    const updatedFrom: Portfolio = { ...from, startDate: from.startDate && from.startDate < input.switchDate ? from.startDate : input.switchDate, updatedAt: now };
    await db.write([S.switches, S.transactions, S.portfolios, S.prices], ({ put }) => {
      put(S.switches, sw);
      for (const t of input.openings) put(S.transactions, t);
      for (const p of input.pricePoints ?? []) put(S.prices, p);
      put(S.portfolios, updatedFrom);
      put(S.portfolios, updatedTo);
    });
    return sw;
  },

  async setMirror(sw: PortfolioSwitch, on: boolean): Promise<void> {
    await (await getDb()).write([S.switches], ({ put }) => put(S.switches, { ...sw, mirrorContributions: on, updatedAt: new Date().toISOString() }));
  },

  async remove(sw: PortfolioSwitch): Promise<void> {
    const tomb: Deletion = { id: sw.id, store: S.switches, deletedAt: new Date().toISOString() };
    await (await getDb()).write([S.switches, S.deletions], ({ put, del }) => {
      del(S.switches, sw.id);
      put(S.deletions, tomb);
    });
  },
};
