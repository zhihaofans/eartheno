/**
 * IndexedDB 存档层。
 *
 * 设计决策：
 * - chunk 尺寸 32×32 = 1024 字节，一条记录一个 chunk，读档只读改动过的 chunk（未改动的按种子重新生成）。
 * - 写入节流 + 切后台强制 flush：移动端最容易丢档的窗口是「切走 App」那一刻。
 * - meta 写入前先存一份滚动备份（保留 3 份），解析失败可回退。
 */
import { parseChunkKey, type MetaState } from '../core/save';

const DB_NAME = 'eartheno';
const DB_VER = 1;

export interface ChunkRecord {
  key: string;
  cx: number;
  cy: number;
  blocks: Uint8Array;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('当前环境不支持 IndexedDB'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      if (!db.objectStoreNames.contains('chunks')) db.createObjectStore('chunks', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('backups')) db.createObjectStore('backups', { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB 打开失败'));
    req.onblocked = () => reject(new Error('IndexedDB 被其他标签页占用'));
  });
}

function tx<T>(db: IDBDatabase, stores: string[], mode: IDBTransactionMode, fn: (t: IDBTransaction) => Promise<T> | T): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    let result: T;
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error ?? new Error('事务中断'));
    Promise.resolve(fn(t)).then(
      (r) => (result = r),
      (e) => {
        try {
          t.abort();
        } catch {
          /* ignore */
        }
        reject(e);
      },
    );
  });
}

function reqP<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export class SaveStore {
  private db: IDBDatabase | null = null;

  async open(): Promise<void> {
    if (!this.db) this.db = await openDB();
  }

  get available(): boolean {
    return !!this.db;
  }

  private need(): IDBDatabase {
    if (!this.db) throw new Error('数据库未打开');
    return this.db;
  }

  async loadMeta(): Promise<MetaState | null> {
    const db = this.need();
    const raw = await tx(db, ['meta'], 'readonly', (t) => reqP(t.objectStore('meta').get('world')));
    if (!raw) return null;
    // 读档失败的兜底：meta 损坏时回退到最近一份备份
    try {
      return JSON.parse(typeof raw === 'string' ? raw : JSON.stringify(raw));
    } catch {
      const b = await this.latestBackup();
      return b;
    }
  }

  async saveMeta(meta: MetaState): Promise<void> {
    const db = this.need();
    const payload = JSON.parse(JSON.stringify(meta));
    await tx(db, ['meta', 'backups'], 'readwrite', async (t) => {
      t.objectStore('meta').put(payload, 'world');
      t.objectStore('backups').add({ at: Date.now(), meta: payload });
      // 只保留 3 份
      const all = (await reqP(t.objectStore('backups').getAllKeys())) as IDBValidKey[];
      for (const k of all.slice(0, Math.max(0, all.length - 3))) t.objectStore('backups').delete(k);
    });
  }

  private async latestBackup(): Promise<MetaState | null> {
    const db = this.need();
    const all = (await tx(db, ['backups'], 'readonly', (t) => reqP(t.objectStore('backups').getAll()))) as {
      meta: MetaState;
    }[];
    return all.length ? all[all.length - 1].meta : null;
  }

  async saveChunks(edits: { key: string; blocks: Uint8Array }[]): Promise<void> {
    if (!edits.length) return;
    const db = this.need();
    await tx(db, ['chunks'], 'readwrite', (t) => {
      const os = t.objectStore('chunks');
      for (const e of edits) {
        const [cx, cy] = parseChunkKey(e.key);
        os.put({ key: e.key, cx, cy, blocks: e.blocks });
      }
    });
  }

  async loadChunks(): Promise<Map<string, Uint8Array>> {
    const db = this.need();
    const rows = (await tx(db, ['chunks'], 'readonly', (t) => reqP(t.objectStore('chunks').getAll()))) as ChunkRecord[];
    const m = new Map<string, Uint8Array>();
    for (const r of rows) {
      // structured clone 可能把 Uint8Array 还原成 ArrayBuffer / number[]
      const b = r.blocks instanceof Uint8Array ? r.blocks : new Uint8Array(r.blocks as ArrayBufferLike);
      if (b.length === 1024) m.set(r.key, b);
    }
    return m;
  }

  /** 替换整个世界：清空旧 chunk 再写新的（导入存档 / 重开） */
  async replaceWorld(meta: MetaState, edits: Map<string, Uint8Array>): Promise<void> {
    const db = this.need();
    await this.saveMeta(meta); // 先备份当前 meta
    await tx(db, ['chunks'], 'readwrite', (t) => {
      const os = t.objectStore('chunks');
      os.clear();
      for (const [key, blocks] of edits) {
        const [cx, cy] = parseChunkKey(key);
        os.put({ key, cx, cy, blocks });
      }
    });
  }

  async wipe(): Promise<void> {
    const db = this.need();
    await tx(db, ['meta', 'chunks', 'backups'], 'readwrite', (t) => {
      t.objectStore('meta').clear();
      t.objectStore('chunks').clear();
      t.objectStore('backups').clear();
    });
  }
}
