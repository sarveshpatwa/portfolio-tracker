import { describe, expect, it } from 'vitest';
import { BackupFormatError, emptySnapshot, makeBackup, parseBackup, type Snapshot } from '../../../src/domain/sync/backup';
import { describeChanges, keyOf, mergeSnapshots } from '../../../src/domain/sync/merge';
import { SNAPSHOT_STORES } from '../../../src/domain/sync/backup';
import type { Instrument, Portfolio, PortfolioAsset, PricePoint, Transaction } from '../../../src/domain/types';

const T = (min: number) => `2026-10-30T10:${String(min).padStart(2, '0')}:00.000Z`;
const portfolio = (id: string, name: string, updatedAt = T(0)): Portfolio => ({
  id, name, createdAt: T(0), updatedAt, buyMode: 'fractional', fractionDigits: 6, topUpWholeShares: false,
});
const instrument = (id: string, name: string, updatedAt = T(0)): Instrument => ({
  id, name, assetClass: 'fund', priceSource: 'manual', currency: 'USD', createdAt: T(0), updatedAt,
});
const link = (id: string, portfolioId: string, instrumentId: string): PortfolioAsset => ({
  id, portfolioId, instrumentId, addedAt: T(0), updatedAt: T(0),
});
const opening = (id: string, portfolioId: string, instrumentId: string, qty: string, seq = 1): Transaction => ({
  id, portfolioId, instrumentId, type: 'OPENING', date: '2026-10-01', quantity: qty, price: '1', amount: qty, seq, createdAt: T(0),
});
const price = (instrumentId: string, date: string, close: string, updatedAt?: string): PricePoint => ({
  instrumentId, date, close, source: 'manual', ...(updatedAt ? { updatedAt } : {}),
});
const snap = (parts: Partial<Snapshot>): Snapshot => ({ ...emptySnapshot(), ...parts });

/** Order-independent view of a snapshot, for comparing results. */
const canonical = (s: Snapshot) =>
  Object.fromEntries(SNAPSHOT_STORES.map((st) => [st, (s[st] as unknown as Record<string, unknown>[]).map((r) => JSON.stringify([keyOf(st, r), r])).sort()]));

// Shared starting point: both devices have portfolio P with asset X.
const base = () =>
  snap({
    portfolios: [portfolio('P', 'Growth')],
    instruments: [instrument('X', 'Fund X')],
    portfolioAssets: [link('L1', 'P', 'X')],
    transactions: [opening('t1', 'P', 'X', '100')],
    prices: [price('X', '2026-10-01', '1', T(0))],
  });

describe('mergeSnapshots', () => {
  it('adds what only the other device has, both ways, ending with the same data', () => {
    const laptop = base();
    laptop.portfolios.push(portfolio('Q', 'Dividend'));
    const phone = base();
    phone.transactions.push({ ...opening('t2', 'P', 'X', '50', 2), type: 'REINVEST' });

    const onPhone = mergeSnapshots(phone, laptop);
    const onLaptop = mergeSnapshots(laptop, phone);
    expect(onPhone.changes.portfolios.added).toBe(1);
    expect(onLaptop.changes.transactions.added).toBe(1);
    expect(canonical(onPhone.result)).toEqual(canonical(onLaptop.result));
    expect(onPhone.problems).toEqual([]);
  });

  it('keeps the most recent edit when both devices changed the same record', () => {
    const laptop = base();
    laptop.portfolios[0] = portfolio('P', 'Growth (laptop)', T(5));
    const phone = base();
    phone.portfolios[0] = portfolio('P', 'Growth (phone)', T(9));

    expect(mergeSnapshots(laptop, phone).result.portfolios[0]?.name).toBe('Growth (phone)');
    expect(mergeSnapshots(phone, laptop).result.portfolios[0]?.name).toBe('Growth (phone)');
    expect(mergeSnapshots(phone, laptop).noChanges).toBe(true); // phone already has the newest
  });

  it('applies a portfolio deletion from the other device, with everything that belonged to it', () => {
    const laptop = base();
    const phone = snap({ deletions: [{ id: 'P', store: 'portfolios', deletedAt: T(3) }], instruments: [instrument('X', 'Fund X')] });
    const plan = mergeSnapshots(laptop, phone);
    expect(plan.result.portfolios).toEqual([]);
    expect(plan.result.transactions).toEqual([]);
    expect(plan.result.portfolioAssets).toEqual([]);
    expect(plan.deletes.portfolios).toEqual(['P']);
    expect(plan.deletes.transactions).toEqual(['t1']);
    expect(plan.changes.portfolios.deleted).toBe(1);
  });

  it('keeps a record that was edited after it was deleted elsewhere', () => {
    const laptop = base();
    laptop.portfolios[0] = portfolio('P', 'Renamed later', T(8));
    const phone = snap({ deletions: [{ id: 'P', store: 'portfolios', deletedAt: T(3) }] });
    expect(mergeSnapshots(laptop, phone).result.portfolios.map((p) => p.name)).toEqual(['Renamed later']);
  });

  it('does not re-add a record this device deleted', () => {
    const phone = snap({ deletions: [{ id: 'P', store: 'portfolios', deletedAt: T(3) }] });
    const plan = mergeSnapshots(phone, base()); // laptop still has P
    expect(plan.result.portfolios).toEqual([]);
    expect(plan.upserts.portfolios).toEqual([]);
    expect(plan.changes.portfolios.added).toBe(0);
  });

  it('merges ledger entries by id without overwriting them', () => {
    const laptop = base();
    const phone = base();
    phone.transactions[0] = { ...phone.transactions[0]!, amount: '999', createdAt: T(30) };
    expect(mergeSnapshots(laptop, phone).result.transactions[0]?.amount).toBe('100');
  });

  it('keeps the newer manual price for the same day', () => {
    const laptop = base();
    laptop.prices.push(price('X', '2026-10-30', '1.05', T(10)));
    const phone = base();
    phone.prices.push(price('X', '2026-10-30', '1.07', T(20)));
    const plan = mergeSnapshots(laptop, phone);
    expect(plan.result.prices.find((p) => p.date === '2026-10-30')?.close).toBe('1.07');
    expect(plan.changes.prices.updated).toBe(1);
  });

  it('removes an asset deleted on the other device, including its ledger entries and prices', () => {
    const laptop = base();
    const phone = snap({
      portfolios: [portfolio('P', 'Growth')],
      deletions: [
        { id: 'L1', store: 'portfolioAssets', deletedAt: T(4) },
        { id: 't1', store: 'transactions', deletedAt: T(4) },
        { id: 'X', store: 'instruments', deletedAt: T(4) },
      ],
    });
    const plan = mergeSnapshots(laptop, phone);
    expect(plan.result.instruments).toEqual([]);
    expect(plan.result.prices).toEqual([]);
    expect(plan.result.transactions).toEqual([]);
    expect(plan.deletes.prices).toEqual([['X', '2026-10-01']]);
  });

  it('keeps an asset definition another portfolio still uses', () => {
    const laptop = base();
    laptop.portfolios.push(portfolio('Q', 'Other'));
    laptop.portfolioAssets.push(link('L2', 'Q', 'X'));
    const phone = snap({ deletions: [{ id: 'L1', store: 'portfolioAssets', deletedAt: T(4) }, { id: 't1', store: 'transactions', deletedAt: T(4) }, { id: 'X', store: 'instruments', deletedAt: T(4) }] });
    const plan = mergeSnapshots(laptop, phone);
    expect(plan.result.instruments.map((i) => i.id)).toEqual(['X']);
    expect(plan.result.prices).toHaveLength(1);
  });

  it('refuses a merge whose ledger would not add up', () => {
    const laptop = base();
    const phone = base();
    phone.transactions.push({ ...opening('t9', 'P', 'X', '500', 3), type: 'SELL' });
    const plan = mergeSnapshots(laptop, phone);
    expect(plan.problems).toHaveLength(1);
    expect(plan.problems[0]).toContain('Growth');
  });

  it('reports no changes when importing the same data', () => {
    expect(mergeSnapshots(base(), base()).noChanges).toBe(true);
  });

  it('describes changes in plain language', () => {
    const laptop = base();
    laptop.portfolios.push(portfolio('Q', 'Dividend'));
    laptop.transactions.push(opening('t5', 'Q', 'X', '1', 5), opening('t6', 'Q', 'X', '1', 6));
    expect(describeChanges(mergeSnapshots(snap({}), laptop).changes)).toEqual([
      'Portfolios: 2 added',
      'Asset: 1 added',
      'Ledger entries: 3 added',
      'Price: 1 added',
    ]);
  });
});

describe('parseBackup', () => {
  it('round-trips a backup', () => {
    const file = JSON.parse(JSON.stringify(makeBackup(base(), 2)));
    const parsed = parseBackup(file, 2);
    expect(parsed.data.transactions).toHaveLength(1);
  });

  it('rejects other files, newer versions and damaged records', () => {
    expect(() => parseBackup({ hello: 1 }, 2)).toThrow(BackupFormatError);
    expect(() => parseBackup(makeBackup(base(), 3), 2)).toThrow(/newer version/);
    const damaged = JSON.parse(JSON.stringify(makeBackup(base(), 2)));
    damaged.data.transactions[0].amount = 'lots';
    expect(() => parseBackup(damaged, 2)).toThrow(/damaged \(transactions #1/);
  });

  it('accepts older backups that lack newer stores', () => {
    const old = JSON.parse(JSON.stringify(makeBackup(base(), 1)));
    delete old.data.portfolioAssets;
    delete old.data.deletions;
    const parsed = parseBackup(old, 2);
    expect(parsed.data.portfolioAssets).toEqual([]);
  });
});

describe('recurring contributions on two devices', () => {
  it('merging two devices that both ran the same scheduled buy keeps one copy', () => {
    // Same rule + same date → the same deterministic ids on both devices.
    const run = (seq: number): Transaction[] => [
      { id: 'rc:R:2026-11-06:deposit', seq, portfolioId: 'P', type: 'DEPOSIT', date: '2026-11-06', amount: '500', contributionId: 'rc:R:2026-11-06', createdAt: T(1) },
      { id: 'rc:R:2026-11-06:buy:X', seq: seq + 1, portfolioId: 'P', type: 'BUY', instrumentId: 'X', quantity: '500', price: '1', date: '2026-11-06', amount: '500', contributionId: 'rc:R:2026-11-06', createdAt: T(2) },
    ];
    const laptop = base();
    laptop.transactions.push(...run(10));
    const phone = base();
    phone.transactions.push(...run(99));
    const plan = mergeSnapshots(laptop, phone);
    expect(plan.noChanges).toBe(true);
    expect(plan.result.transactions.filter((t) => t.contributionId === 'rc:R:2026-11-06')).toHaveLength(2);
  });
});
