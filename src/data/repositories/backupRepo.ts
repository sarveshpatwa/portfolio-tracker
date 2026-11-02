/**
 * Backup & restore storage operations.
 *
 *   export:  read every data store → backup JSON (domain/sync/backup.ts)
 *   import:  parse file → merge plan against this device (domain/sync/merge.ts)
 *            → user confirms → apply the plan in ONE atomic write
 *
 * The plan is recomputed right before applying, so changes made between the
 * preview and the confirmation can't be lost.
 */

import { makeBackup, parseBackup, SNAPSHOT_STORES, type BackupFile, type Snapshot } from '../../domain/sync/backup';
import { mergeSnapshots, type MergePlan } from '../../domain/sync/merge';
import { DB_VERSION, getDb, S } from '../db/schema';
import { ValidationError } from './errors';

export const SETTINGS_KEYS = { lastBackupAt: 'lastBackupAt', lastRestoreAt: 'lastRestoreAt' } as const;

interface SettingRow {
  key: string;
  value: unknown;
}

export const backupRepo = {
  async snapshot(): Promise<Snapshot> {
    const db = await getDb();
    const lists = await Promise.all(SNAPSHOT_STORES.map((s) => db.getAll(s)));
    return Object.fromEntries(SNAPSHOT_STORES.map((s, i) => [s, lists[i]])) as unknown as Snapshot;
  },

  /**
   * Downloaded market prices are left out: they can be large (years of daily
   * closes per ticker) and each device re-downloads them from the provider.
   * Manual prices are included — they exist only because you typed them —
   * and so are price-link prices: Vanguard's feed only gives today's price, so
   * past days can't be downloaded again.
   */
  async createBackup(): Promise<BackupFile> {
    const snap = await this.snapshot();
    return makeBackup({ ...snap, prices: snap.prices.filter((p) => p.source !== 'market') }, DB_VERSION);
  },

  /** Call after the file was actually shared or downloaded. */
  async markBackedUp(at = new Date()): Promise<void> {
    await setSetting(SETTINGS_KEYS.lastBackupAt, at.toISOString());
  },

  async readFile(text: string): Promise<BackupFile> {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new ValidationError('This file isn’t a backup (it isn’t valid JSON).');
    }
    try {
      return parseBackup(json, DB_VERSION);
    } catch (err) {
      throw new ValidationError(err instanceof Error ? err.message : 'The backup file couldn’t be read.');
    }
  },

  async previewMerge(file: BackupFile): Promise<MergePlan> {
    return mergeSnapshots(await this.snapshot(), file.data);
  },

  async applyMerge(file: BackupFile): Promise<MergePlan> {
    const plan = await this.previewMerge(file);
    if (plan.problems.length > 0) throw new ValidationError(plan.problems.join(' '));
    if (plan.noChanges) return plan;
    const db = await getDb();
    await db.write([...SNAPSHOT_STORES, S.settings], ({ put, del }) => {
      for (const store of SNAPSHOT_STORES) {
        for (const key of plan.deletes[store]) del(store, key);
        for (const record of plan.upserts[store]) put(store, record);
      }
      put(S.settings, { key: SETTINGS_KEYS.lastRestoreAt, value: new Date().toISOString() } satisfies SettingRow);
    });
    return plan;
  },

  async lastBackupAt(): Promise<string | undefined> {
    return getSetting<string>(SETTINGS_KEYS.lastBackupAt);
  },

  /**
   * Deletes all portfolio data on THIS device (settings such as the API key
   * are kept). No tombstones are written, so this does not delete anything on
   * other devices when backups are merged later.
   */
  async clearAllData(): Promise<void> {
    const db = await getDb();
    await db.write([...SNAPSHOT_STORES, S.settings], ({ clear, del }) => {
      for (const store of SNAPSHOT_STORES) clear(store);
      del(S.settings, SETTINGS_KEYS.lastBackupAt);
      del(S.settings, SETTINGS_KEYS.lastRestoreAt);
    });
  },
};

async function getSetting<T>(key: string): Promise<T | undefined> {
  const row = await (await getDb()).get<SettingRow>(S.settings, key);
  return row?.value as T | undefined;
}

async function setSetting(key: string, value: unknown): Promise<void> {
  await (await getDb()).write([S.settings], ({ put }) => put(S.settings, { key, value } satisfies SettingRow));
}
