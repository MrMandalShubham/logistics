import type { OutboxEvent } from "./outbox";

/**
 * The IndexedDB adapter.
 *
 * Deliberately dull, and deliberately tiny. Every decision — what to
 * send, in what order, what to keep, what is stale — lives in
 * outbox.ts where it can be tested. This file only moves bytes.
 *
 * If you find yourself adding an `if` here, it probably belongs next
 * door.
 */

const DB_NAME = "logistics-outbox";
const STORE = "events";
const VERSION = 1;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "client_event_id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await open();
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error);
    t.oncomplete = () => db.close();
  });
}

export async function put(event: OutboxEvent): Promise<void> {
  await tx("readwrite", (s) => s.put(event));
}

export async function all(): Promise<OutboxEvent[]> {
  return (await tx<OutboxEvent[]>("readonly", (s) => s.getAll())) ?? [];
}

export async function remove(clientEventId: string): Promise<void> {
  await tx("readwrite", (s) => s.delete(clientEventId));
}

/**
 * Replace the queue wholesale.
 *
 * Used after a sync: outbox.applyResults() has already decided what
 * survives, and this writes that decision down. Clearing first means
 * an event the pure logic dropped cannot linger.
 */
export async function replaceAll(events: OutboxEvent[]): Promise<void> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, "readwrite");
    const s = t.objectStore(STORE);
    s.clear();
    for (const e of events) s.put(e);
    t.oncomplete = () => { db.close(); resolve(); };
    t.onerror = () => reject(t.error);
  });
}

/**
 * Wipe everything.
 *
 * Called on sign-out. A phone that has been handed back, sold or lost
 * must not still hold customers' addresses and phone numbers.
 */
export async function clear(): Promise<void> {
  await tx("readwrite", (s) => s.clear());
}

export function isSupported(): boolean {
  return typeof indexedDB !== "undefined";
}
