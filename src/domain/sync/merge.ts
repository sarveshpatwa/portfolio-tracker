/**
 * Merging a backup from another device into this one.
 *
 * Rules, applied per data store:
 *
 *  1. New records (id not on this device) are added.
 *  2. Editable records (portfolios, assets, portfolio assets, recurring rules,
 *     switches, manual/link prices) present on both sides: the one with the later
 *     `updatedAt` wins ("last edit wins"). Ties keep this device's copy.
 *     Exception: for a price on the same day, a typed (manual) price beats a
 *     fetched (price-link) one.
 *  3. Ledger entries and allocation-plan versions are never edited, only
 *     added, so they just merge by id.
 *  4. Deletions (tombstones) from both sides are combined. A tombstone removes
 *     its record unless that record was edited AFTER the deletion.
 *     Deleting a portfolio also removes everything that belongs to it;
 *     deleting an asset definition also removes its price history.
 *  5. Safety: every portfolio's ledger is replayed after the merge. If any
 *     replay fails, the merge reports the problem and must not be applied.
 *
 * Merging is symmetric in content: importing A into B and B into A ends with
 * the same data on both devices (apart from ties, which are rare because
 * timestamps include milliseconds).
 */

import { LedgerError, replayLedger } from '../portfolio/ledger';
import type { Deletion, Transaction } from '../types';
import { SNAPSHOT_STORES, emptySnapshot, type Snapshot, type StoreKey } from './backup';

type AnyRecord = Record<string, unknown>;

export interface StoreChanges {
  added: number;
  updated: number;
  deleted: number;
}

export interface MergePlan {
  /** Records to write (insert or replace) on this device. */
  upserts: Snapshot;
  /** Keys to delete on this device (prices use [instrumentId, date]). */
  deletes: Record<StoreKey, (string | [string, string])[]>;
  changes: Record<StoreKey, StoreChanges>;
  /** True when nothing would change. */
  noChanges: boolean;
  /** Ledger problems found after merging; if non-empty the plan must not be applied. */
  problems: string[];
  /** Data as it will be after applying (useful for previews and tests). */
  result: Snapshot;
}

const ADD_ONLY: ReadonlySet<StoreKey> = new Set(['transactions', 'allocationPlans']);

export function keyOf(store: StoreKey, r: AnyRecord): string {
  return store === 'prices' ? `${String(r.instrumentId)}|${String(r.date)}` : String(r.id);
}

function stamp(r: AnyRecord): string {
  return String(r.updatedAt ?? r.createdAt ?? r.addedAt ?? '');
}

/**
 * Newer edit wins — except for prices on the same day, where a price typed by
 * hand always beats one fetched from a price link (on either device).
 */
function incomingWins(store: StoreKey, incoming: AnyRecord, mine: AnyRecord): boolean {
  if (store === 'prices' && incoming.source !== mine.source) {
    if (mine.source === 'manual' && incoming.source === 'link') return false;
    if (incoming.source === 'manual' && mine.source === 'link') return true;
  }
  return stamp(incoming) > stamp(mine);
}

export function mergeSnapshots(local: Snapshot, incoming: Snapshot): MergePlan {
  const merged = new Map<StoreKey, Map<string, AnyRecord>>();
  const upsertKeys = new Map<StoreKey, Set<string>>();
  const changes = {} as Record<StoreKey, StoreChanges>;

  // --- 1–3: add / update -------------------------------------------------
  for (const store of SNAPSHOT_STORES) {
    const map = new Map<string, AnyRecord>();
    for (const r of local[store] as unknown as AnyRecord[]) map.set(keyOf(store, r), r);
    merged.set(store, map);
    upsertKeys.set(store, new Set());
    changes[store] = { added: 0, updated: 0, deleted: 0 };
    if (store === 'deletions') continue;

    for (const r of incoming[store] as unknown as AnyRecord[]) {
      const key = keyOf(store, r);
      const mine = map.get(key);
      if (!mine) {
        map.set(key, r);
        upsertKeys.get(store)!.add(key);
        changes[store].added++;
      } else if (!ADD_ONLY.has(store) && incomingWins(store, r, mine)) {
        map.set(key, r);
        upsertKeys.get(store)!.add(key);
        changes[store].updated++;
      }
    }
  }

  // --- 4: tombstones -----------------------------------------------------
  const tombstones = merged.get('deletions')!;
  for (const d of incoming.deletions) {
    const mine = tombstones.get(d.id) as Deletion | undefined;
    if (!mine || d.deletedAt > mine.deletedAt) {
      tombstones.set(d.id, d as unknown as AnyRecord);
      upsertKeys.get('deletions')!.add(d.id);
      if (!mine) changes.deletions.added++;
    }
  }

  const localKeys = new Map<StoreKey, Set<string>>(
    SNAPSHOT_STORES.map((s) => [s, new Set((local[s] as unknown as AnyRecord[]).map((r) => keyOf(s, r)))]),
  );
  const deleteKeys = new Map<StoreKey, Set<string>>(SNAPSHOT_STORES.map((s) => [s, new Set<string>()]));
  const remove = (store: StoreKey, key: string) => {
    const map = merged.get(store)!;
    if (!map.has(key)) return;
    map.delete(key);
    const wasUpsert = upsertKeys.get(store)!.delete(key);
    const isLocal = localKeys.get(store)!.has(key);
    if (wasUpsert) changes[store][isLocal ? 'updated' : 'added']--;
    if (isLocal) {
      deleteKeys.get(store)!.add(key);
      changes[store].deleted++;
    }
  };

  // Pass 1: everything except asset definitions.
  const deletedPortfolios = new Set<string>();
  const instrumentTombstones: Deletion[] = [];
  for (const t of tombstones.values()) {
    const d = t as unknown as Deletion;
    const store = d.store as StoreKey;
    if (store === 'instruments') {
      instrumentTombstones.push(d);
      continue;
    }
    const map = merged.get(store);
    if (!map) continue;
    const record = map.get(d.id);
    if (record && stamp(record) > d.deletedAt) continue; // edited after the deletion → keep
    remove(store, d.id);
    if (store === 'portfolios') deletedPortfolios.add(d.id);
  }

  // Cascade: a deleted portfolio takes everything that belongs to it.
  for (const store of ['transactions', 'portfolioAssets', 'allocationPlans', 'contributionRules'] as const) {
    for (const [key, r] of [...merged.get(store)!]) if (deletedPortfolios.has(String(r.portfolioId))) remove(store, key);
  }
  for (const [key, r] of [...merged.get('switches')!]) {
    if (deletedPortfolios.has(String(r.fromPortfolioId)) || deletedPortfolios.has(String(r.toPortfolioId))) remove('switches', key);
  }

  // Pass 2: asset definitions (and their price history) — only once no portfolio uses them any more.
  const stillLinked = new Set([...merged.get('portfolioAssets')!.values()].map((r) => String(r.instrumentId)));
  const stillTraded = new Set([...merged.get('transactions')!.values()].map((r) => String(r.instrumentId ?? '')));
  for (const d of instrumentTombstones) {
    const record = merged.get('instruments')!.get(d.id);
    if (record && stamp(record) > d.deletedAt) continue;
    if (stillLinked.has(d.id) || stillTraded.has(d.id)) continue;
    remove('instruments', d.id);
    for (const [key, r] of [...merged.get('prices')!]) if (String(r.instrumentId) === d.id) remove('prices', key);
  }

  // --- Build outputs -------------------------------------------------------
  const result = emptySnapshot();
  const upserts = emptySnapshot();
  const deletes = {} as Record<StoreKey, (string | [string, string])[]>;
  for (const store of SNAPSHOT_STORES) {
    const map = merged.get(store)!;
    (result[store] as unknown as AnyRecord[]) = [...map.values()];
    (upserts[store] as unknown as AnyRecord[]) = [...upsertKeys.get(store)!].map((k) => map.get(k)!).filter(Boolean);
    deletes[store] = [...deleteKeys.get(store)!].map((k) => (store === 'prices' ? (k.split('|') as [string, string]) : k));
  }

  // --- 5: ledger safety ---------------------------------------------------
  const problems: string[] = [];
  const byPortfolio = new Map<string, Transaction[]>();
  for (const t of result.transactions) {
    const list = byPortfolio.get(t.portfolioId);
    if (list) list.push(t);
    else byPortfolio.set(t.portfolioId, [t]);
  }
  for (const [pid, txs] of byPortfolio) {
    try {
      replayLedger(txs);
    } catch (err) {
      if (!(err instanceof LedgerError)) throw err;
      const name = result.portfolios.find((p) => p.id === pid)?.name ?? 'a portfolio';
      problems.push(`The ledger of “${name}” wouldn’t add up after merging (${err.message}).`);
    }
  }

  const noChanges = SNAPSHOT_STORES.every((s) => upserts[s].length === 0 && deletes[s].length === 0);
  return { upserts, deletes, changes, noChanges, problems, result };
}

/** Plain-language lines for the import preview, e.g. "2 portfolios added". */
export function describeChanges(changes: Record<StoreKey, StoreChanges>): string[] {
  const labels: Partial<Record<StoreKey, [string, string]>> = {
    portfolios: ['portfolio', 'portfolios'],
    portfolioAssets: ['asset', 'assets'],
    transactions: ['ledger entry', 'ledger entries'],
    prices: ['price', 'prices'],
    contributionRules: ['recurring contribution', 'recurring contributions'],
    allocationPlans: ['allocation version', 'allocation versions'],
    switches: ['switch', 'switches'],
  };
  const lines: string[] = [];
  for (const [store, [one, many]] of Object.entries(labels) as [StoreKey, [string, string]][]) {
    const c = changes[store];
    const parts: string[] = [];
    if (c.added > 0) parts.push(`${c.added} added`);
    if (c.updated > 0) parts.push(`${c.updated} updated`);
    if (c.deleted > 0) parts.push(`${c.deleted} deleted`);
    const total = c.added + c.updated + c.deleted;
    if (parts.length) lines.push(`${total === 1 ? one : many}: ${parts.join(', ')}`);
  }
  return lines.map((l) => l.charAt(0).toUpperCase() + l.slice(1));
}
