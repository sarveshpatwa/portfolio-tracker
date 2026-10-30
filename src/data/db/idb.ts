/**
 * A small promise wrapper around IndexedDB (instead of a library such as Dexie).
 *
 * It covers what the app needs: open with versioned migrations, read/write
 * single records, query an index, and run multi-store transactions
 * atomically. After every successful write it notifies subscribers of the
 * stores that changed, which is how React screens refresh automatically
 * (application/useLiveQuery.ts).
 */

export type StoreName = string;
export type Upgrade = (db: IDBDatabase, tx: IDBTransaction, oldVersion: number) => void;

type Listener = (changed: ReadonlySet<StoreName>) => void;

export class Database {
  private readonly listeners = new Set<Listener>();

  private constructor(private readonly db: IDBDatabase) {
    // Another tab upgraded the schema: close so it isn't blocked, and reload.
    db.onversionchange = () => {
      db.close();
      if (typeof location !== 'undefined') location.reload();
    };
  }

  static open(name: string, version: number, upgrade: Upgrade): Promise<Database> {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('This browser does not support IndexedDB, so the app cannot store data.'));
        return;
      }
      const req = indexedDB.open(name, version);
      req.onupgradeneeded = (event) => {
        const tx = req.transaction;
        if (tx) upgrade(req.result, tx, event.oldVersion);
      };
      req.onsuccess = () => resolve(new Database(req.result));
      req.onerror = () => reject(req.error ?? new Error('Could not open the database.'));
      req.onblocked = () => reject(new Error('Close other tabs of this app and try again (database upgrade blocked).'));
    });
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
    return this.read(store, (s) => s.get(key) as IDBRequest<T | undefined>);
  }

  getAll<T>(store: StoreName): Promise<T[]> {
    return this.read(store, (s) => s.getAll() as IDBRequest<T[]>);
  }

  getAllByIndex<T>(store: StoreName, index: string, value: IDBValidKey | IDBKeyRange): Promise<T[]> {
    return this.read(store, (s) => s.index(index).getAll(value) as IDBRequest<T[]>);
  }

  /**
   * Runs `work` inside one readwrite transaction over `stores`. Either every
   * write in it is saved or none is (IndexedDB transactions are atomic).
   * `work` must only use the provided `put`/`del` helpers synchronously or via
   * the returned store handles — awaiting other promises inside it would let
   * the transaction auto-commit early.
   */
  write(
    stores: StoreName[],
    work: (ops: {
      put: (store: StoreName, value: unknown) => void;
      del: (store: StoreName, key: IDBValidKey) => void;
      deleteByIndex: (store: StoreName, index: string, value: IDBValidKey) => void;
      clear: (store: StoreName) => void;
    }) => void,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(stores, 'readwrite');
      tx.oncomplete = () => {
        resolve();
        const changed = new Set(stores);
        for (const l of this.listeners) l(changed);
      };
      tx.onerror = () => reject(tx.error ?? new Error('Database write failed.'));
      tx.onabort = () => reject(tx.error ?? new Error('Database write was aborted.'));
      try {
        work({
          put: (store, value) => void tx.objectStore(store).put(value),
          del: (store, key) => void tx.objectStore(store).delete(key),
          clear: (store) => void tx.objectStore(store).clear(),
          deleteByIndex: (store, index, value) => {
            const cursorReq = tx.objectStore(store).index(index).openKeyCursor(value);
            cursorReq.onsuccess = () => {
              const cursor = cursorReq.result;
              if (!cursor) return;
              tx.objectStore(store).delete(cursor.primaryKey);
              cursor.continue();
            };
          },
        });
      } catch (err) {
        tx.abort();
        reject(err);
      }
    });
  }

  close(): void {
    this.db.close();
  }

  private read<T>(store: StoreName, op: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const req = op(this.db.transaction(store, 'readonly').objectStore(store));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error(`Could not read ${store}.`));
    });
  }
}
