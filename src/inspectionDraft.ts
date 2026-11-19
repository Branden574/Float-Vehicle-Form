import { api } from './api';
import { useEffect, useState } from 'react';
import type { Inspection, Photo, Vehicle } from './types';

export type DraftSlot = {
  key: string;
  view: string;
  photo?: Photo;
  file?: File;
  capturedAt?: string;
  source?: 'camera' | 'upload';
};
export type InspectionDraft = {
  draftId: string;
  step: number;
  due: string;
  mileage: string;
  confirmed: boolean;
  inspection: Partial<Inspection>;
  slots: DraftSlot[];
  pending: { key: string; body: unknown } | null;
};
type Sealed = { iv: Uint8Array<ArrayBuffer>; data: ArrayBuffer };
type Row = { id: string; expires: number; revision: string; manifest: Sealed; files: Sealed[] };
const lifetime = 24 * 60 * 60 * 1000;
function idb<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function database() {
  const request = indexedDB.open('fleet-private-inspections', 1);
  request.onupgradeneeded = () => {
    request.result.createObjectStore('drafts', { keyPath: 'id' }).createIndex('expires', 'expires');
  };
  return idb(request);
}

export function checkoutContext(vehicle: Vehicle) {
  return 'checkout/' + vehicle.id + '/' + (vehicle.mileageVersion ?? vehicle.currentMileage);
}
export function returnContext(tripId: string) {
  return 'return/' + tripId;
}

export function useDraftContexts(owner?: string, editing = false) {
  const [saved, setSaved] = useState<{ owner: string; contexts: Set<string> }>();
  useEffect(() => {
    if (!owner || editing) return;
    let active = true;
    (async () => {
      const db = await database();
      const contexts = new Set<string>();
      const tx = db.transaction('drafts');
      const cursor = tx
        .objectStore('drafts')
        .index('expires')
        .openKeyCursor(IDBKeyRange.lowerBound(Date.now(), true));
      const prefix = owner + '/';
      cursor.onsuccess = () => {
        const entry = cursor.result;
        if (!entry) return;
        const id = String(entry.primaryKey);
        if (id.startsWith(prefix)) contexts.add(id.slice(prefix.length));
        entry.continue();
      };
      tx.oncomplete = () => {
        db.close();
        if (active) setSaved({ owner, contexts });
      };
      tx.onabort = () => db.close();
    })().catch(() => {});
    return () => {
      active = false;
    };
  }, [owner, editing]);
  return owner === saved?.owner ? saved?.contexts : undefined;
}

export async function deleteLocalDrafts(owner: string) {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('drafts', 'readwrite');
      const prefix = owner + '/';
      tx.objectStore('drafts').delete(IDBKeyRange.bound(prefix, prefix + '\uffff'));
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export class DraftVault {
  private revision?: string;
  private queue: Promise<unknown> = Promise.resolve();
  private fileCache = new WeakMap<File, Promise<Sealed>>();
  private constructor(
    private db: IDBDatabase,
    private id: string,
    private key: CryptoKey,
  ) {}
  static async open(owner: string, context: string) {
    const response = await api<{ owner: string; key: string }>('/inspection-draft-key');
    if (response.owner !== owner) throw Error('Your session changed. Reopen the inspection.');
    const key = await crypto.subtle.importKey(
      'raw',
      Uint8Array.from(atob(response.key), (c) => c.charCodeAt(0)),
      'AES-GCM',
      false,
      ['encrypt', 'decrypt'],
    );
    const db = await database();
    const tx = db.transaction('drafts', 'readwrite');
    const cursor = tx
      .objectStore('drafts')
      .index('expires')
      .openCursor(IDBKeyRange.upperBound(Date.now()));
    cursor.onsuccess = () => {
      if (cursor.result) {
        cursor.result.delete();
        cursor.result.continue();
      }
    };
    const vault = new DraftVault(db, owner + '/' + context, key);
    return vault;
  }
  private async seal(raw: ArrayBuffer) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    return {
      iv,
      data: await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(this.id) },
        this.key,
        raw,
      ),
    };
  }
  private unseal(value: Sealed) {
    return crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: value.iv, additionalData: new TextEncoder().encode(this.id) },
      this.key,
      value.data,
    );
  }
  async read(): Promise<InspectionDraft | undefined> {
    const row: Row | undefined = await idb(
      this.db.transaction('drafts').objectStore('drafts').get(this.id),
    );
    if (!row) return;
    this.revision = row.revision;
    const saved = JSON.parse(new TextDecoder().decode(await this.unseal(row.manifest)));
    const slots = await Promise.all(
      saved.slots.map(
        async (
          slot: DraftSlot & {
            attachment?: { index: number; name: string; type: string; lastModified: number };
          },
        ) => {
          const { attachment, ...rest } = slot;
          if (!attachment) return rest;
          const sealed = row.files[attachment.index];
          const file = new File([await this.unseal(sealed)], attachment.name, attachment);
          this.fileCache.set(file, Promise.resolve(sealed));
          return { ...rest, file };
        },
      ),
    );
    return { ...saved, slots };
  }
  save(draft: InspectionDraft) {
    const task = this.queue
      .catch(() => {})
      .then(async () => {
        const files: Promise<Sealed>[] = [];
        const slots = draft.slots.map(({ key, view, photo, source, capturedAt, file }) => {
          if (!file || photo) return { key, view, photo, source, capturedAt };
          let sealed = this.fileCache.get(file);
          if (!sealed) {
            sealed = file.arrayBuffer().then((data) => this.seal(data));
            this.fileCache.set(file, sealed);
          }
          const index = files.push(sealed) - 1;
          return {
            key,
            view,
            source,
            capturedAt,
            attachment: {
              index,
              name: file.name,
              type: file.type,
              lastModified: file.lastModified,
            },
          };
        });
        const row: Row = {
          id: this.id,
          revision: crypto.randomUUID(),
          expires: Date.now() + lifetime,
          manifest: await this.seal(
            new TextEncoder().encode(JSON.stringify({ ...draft, slots })).buffer,
          ),
          files: await Promise.all(files),
        };
        await this.replace(row);
      });
    this.queue = task;
    return task;
  }
  async remove() {
    await this.queue.catch(() => {});
    await this.replace();
  }
  private replace(row?: Row) {
    return new Promise<void>((resolve, reject) => {
      const tx = this.db.transaction('drafts', 'readwrite');
      const store = tx.objectStore('drafts');
      const request = store.get(this.id);
      request.onsuccess = () => {
        if (request.result?.revision !== this.revision) {
          tx.abort();
          return;
        }
        if (row) store.put(row);
        else store.delete(this.id);
      };
      tx.oncomplete = () => {
        this.revision = row?.revision;
        resolve();
      };
      tx.onabort = () =>
        reject(tx.error ?? Error('This draft changed in another tab. Reopen it to continue.'));
      tx.onerror = () => reject(tx.error ?? Error('Device storage is unavailable.'));
    });
  }
  close() {
    void this.queue.catch(() => {}).then(() => this.db.close());
  }
}
