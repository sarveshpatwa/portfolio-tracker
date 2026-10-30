/**
 * Backup file format.
 *
 * A backup is one JSON file holding every record of the app's data stores.
 * Settings (API key, refresh interval) are deliberately NOT included: they
 * belong to the device, and a backup file may be sent over email or chat.
 *
 * Files carry the database schema version they were made with. A file from a
 * NEWER app version is refused (this device must update first); files from
 * older versions are accepted because newer schemas only add fields/stores.
 */

import type {
  AllocationPlan,
  ContributionRule,
  Deletion,
  Instrument,
  Portfolio,
  PortfolioAsset,
  PortfolioSwitch,
  PricePoint,
  Transaction,
} from '../types';

export const BACKUP_FORMAT = 'portfolio-tracker-backup';
export const BACKUP_FORMAT_VERSION = 1;

export interface Snapshot {
  portfolios: Portfolio[];
  instruments: Instrument[];
  portfolioAssets: PortfolioAsset[];
  transactions: Transaction[];
  allocationPlans: AllocationPlan[];
  contributionRules: ContributionRule[];
  switches: PortfolioSwitch[];
  prices: PricePoint[];
  deletions: Deletion[];
}

export type StoreKey = keyof Snapshot;

export const SNAPSHOT_STORES: readonly StoreKey[] = [
  'portfolios',
  'instruments',
  'portfolioAssets',
  'transactions',
  'allocationPlans',
  'contributionRules',
  'switches',
  'prices',
  'deletions',
];

export interface BackupFile {
  format: typeof BACKUP_FORMAT;
  formatVersion: number;
  schemaVersion: number;
  exportedAt: string;
  data: Snapshot;
}

export function emptySnapshot(): Snapshot {
  return {
    portfolios: [],
    instruments: [],
    portfolioAssets: [],
    transactions: [],
    allocationPlans: [],
    contributionRules: [],
    switches: [],
    prices: [],
    deletions: [],
  };
}

export function makeBackup(data: Snapshot, schemaVersion: number, now = new Date()): BackupFile {
  return { format: BACKUP_FORMAT, formatVersion: BACKUP_FORMAT_VERSION, schemaVersion, exportedAt: now.toISOString(), data };
}

/** "portfolio-backup-2026-10-30-2315.json" (device local time) */
export function backupFileName(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `portfolio-backup-${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}.json`;
}

export class BackupFormatError extends Error {}

/**
 * Checks that parsed JSON is a backup this app can read. Validates the shape
 * of every record enough that a bad file can't corrupt the database; the
 * finer financial consistency check happens in the merge (ledger replay).
 */
export function parseBackup(json: unknown, currentSchemaVersion: number): BackupFile {
  if (!isObject(json) || json.format !== BACKUP_FORMAT) {
    throw new BackupFormatError('This isn’t a Portfolio Tracker backup file.');
  }
  if (typeof json.formatVersion !== 'number' || json.formatVersion > BACKUP_FORMAT_VERSION) {
    throw new BackupFormatError('This backup was made by a newer version of the app. Update the app on this device first.');
  }
  if (typeof json.schemaVersion !== 'number' || json.schemaVersion > currentSchemaVersion) {
    throw new BackupFormatError('This backup was made by a newer version of the app. Update the app on this device first.');
  }
  if (typeof json.exportedAt !== 'string' || !isObject(json.data)) {
    throw new BackupFormatError('The backup file is incomplete or damaged.');
  }

  const raw = json.data;
  const data = emptySnapshot();
  for (const store of SNAPSHOT_STORES) {
    const list = raw[store];
    if (list === undefined) continue; // older backups may lack newer stores
    if (!Array.isArray(list)) throw new BackupFormatError(`The backup file is damaged (${store}).`);
    for (const [i, record] of list.entries()) {
      const problem = checkRecord(store, record);
      if (problem) throw new BackupFormatError(`The backup file is damaged (${store} #${i + 1}: ${problem}).`);
    }
    (data[store] as unknown[]) = list;
  }
  return { format: BACKUP_FORMAT, formatVersion: json.formatVersion, schemaVersion: json.schemaVersion, exportedAt: json.exportedAt, data };
}

const DECIMAL_RE = /^-?\d+(\.\d+)?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function checkRecord(store: StoreKey, r: unknown): string | null {
  if (!isObject(r)) return 'not an object';
  const str = (k: string) => typeof r[k] === 'string' && (r[k] as string).length > 0;
  const dec = (k: string) => typeof r[k] === 'string' && DECIMAL_RE.test(r[k] as string);
  const optDec = (k: string) => r[k] === undefined || dec(k);
  const date = (k: string) => typeof r[k] === 'string' && DATE_RE.test(r[k] as string);

  switch (store) {
    case 'prices':
      if (!str('instrumentId') || !date('date') || !dec('close')) return 'bad price';
      if (r.source !== 'market' && r.source !== 'manual') return 'bad price source';
      return null;
    case 'deletions':
      return str('id') && str('store') && str('deletedAt') ? null : 'bad deletion';
    default:
      if (!str('id')) return 'missing id';
  }
  switch (store) {
    case 'portfolios':
      return str('name') && str('createdAt') ? null : 'bad portfolio';
    case 'instruments':
      return str('name') && (r.priceSource === 'market' || r.priceSource === 'manual') ? null : 'bad asset';
    case 'portfolioAssets':
      return str('portfolioId') && str('instrumentId') ? null : 'bad portfolio asset';
    case 'transactions':
      if (!str('portfolioId') || !str('type') || !date('date') || !dec('amount')) return 'bad ledger entry';
      if (typeof r.seq !== 'number') return 'bad ledger order';
      return optDec('quantity') && optDec('price') ? null : 'bad ledger numbers';
    case 'allocationPlans':
      return str('portfolioId') && Array.isArray(r.targets) ? null : 'bad allocation plan';
    case 'contributionRules':
      return str('portfolioId') && dec('amount') && date('startDate') ? null : 'bad recurring rule';
    case 'switches':
      return str('fromPortfolioId') && str('toPortfolioId') && date('switchDate') ? null : 'bad switch';
    default:
      return null;
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
