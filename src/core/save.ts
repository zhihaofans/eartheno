/**
 * 存档编解码 —— 纯函数，不碰存储。
 *
 * 格式约定（经验文档 §1、§7）：
 * - `fmt` 是整数 monotonic（给代码用），`ver` 是语义版本（给用户看），两者不混。
 * - 导出文件很小：chunk 用 RLE + base64，1024 字节的 chunk 通常压到 80–300 字节。
 * - 导入必须先校验再合并，校验失败要给**具体原因**，不是一句"文件损坏"。
 */

import { CHUNK, CHUNK_AREA, APP_ID, SAVE_FMT, WORLD } from './constants';
import type { InventoryData } from './inventory';
import { emptyInventory, sanitizeInventory } from './inventory';

export interface PlayerState {
  x: number;
  y: number;
  facing: -1 | 1;
  /** 累计游玩秒数 */
  playSec: number;
  /** 快捷栏选中格 */
  active: number;
}

export interface MetaState {
  seed: number;
  player: PlayerState;
  inv: InventoryData;
  /** 已发现的最大深度（tile），用于成就式提示 */
  deepest: number;
  createdAt: string;
  savedAt: string;
}

export interface ChunkSave {
  cx: number;
  cy: number;
  rle: string;
}

export interface SaveFile {
  app: string;
  fmt: number;
  ver: string;
  savedAt: string;
  meta: MetaState;
  chunks: ChunkSave[];
}

/** 存档格式版本。2 = 世界顶部上移两行（cyMin 0 → -2），老存档需要补天空 */
export const SAVE_FMT_CURRENT = 2;

/**
 * 老存档（fmt < 2）的"天空行"迁移。
 *
 * 何时需要：早期 WORLD.cyMin 是 0，世界顶就是第 0 行区块 —— 走到稍高处头顶就没东西了，
 * 远处的山也整片消失。修法是把顶部上移两行（cyMin = -2），但老存档里凡是被改过的
 * chunk，整块字节都会从数据库原样读回；-2/-1 这两行读回来是全 0（空气），看着没问题。
 *
 * 真正的坑在另一处：旧版生成器对这个高度**没有**"必定空气"的保证 —— 万一某天
 * 地表生成参数改动，sky 行被填了土，读档时就是"天上一块土"。所以这里顺手校验：
 * 与**当前**生成器结果逐字节比对，只替换不同的部分，玩家挖过的地方原样保留。
 *
 * @param chunks 读档得到的 chunk 表（键为 "cx,cy"），**原地修改**
 * @returns 是否真的改动了任何 chunk
 */
export function migrateSkyRows(
  chunks: Map<string, Uint8Array>,
  gen: (cx: number, cy: number) => Uint8Array | null,
): boolean {
  let touched = false;
  for (let cy = WORLD.cyMin; cy < 0; cy++) {
    for (let cx = WORLD.cxMin; cx <= WORLD.cxMax; cx++) {
      const k = chunkKey(cx, cy);
      const cur = chunks.get(k);
      if (!cur) continue; // 没存过 = 读档时会按新生成器生成，本身就是干净的
      const ref = gen(cx, cy);
      if (!ref) continue;
      let diff = false;
      for (let i = 0; i < cur.length; i++) {
        if (cur[i] !== ref[i]) {
          cur[i] = ref[i];
          diff = true;
        }
      }
      if (diff) touched = true;
    }
  }
  return touched;
}

export function newMeta(seed: number, spawn: { x: number; y: number }): MetaState {
  const now = new Date().toISOString();
  return {
    seed,
    player: { x: spawn.x, y: spawn.y, facing: 1, playSec: 0, active: 0 },
    inv: emptyInventory(),
    deepest: Math.floor(spawn.y),
    createdAt: now,
    savedAt: now,
  };
}

// ── 变长整数 ────────────────────────────────────────────

export function writeVarint(out: number[], v: number): void {
  let n = v >>> 0;
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n);
}

export function readVarint(buf: Uint8Array, offset: number): { value: number; next: number } {
  let shift = 0;
  let v = 0;
  let i = offset;
  while (i < buf.length) {
    const b = buf[i++];
    v |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) return { value: v >>> 0, next: i };
    shift += 7;
    if (shift > 35) break;
  }
  throw new Error('RLE 数据截断');
}

// ── RLE ─────────────────────────────────────────────────

export function rleEncode(blocks: Uint8Array): string {
  const out: number[] = [];
  let i = 0;
  while (i < blocks.length) {
    const v = blocks[i];
    let run = 1;
    while (i + run < blocks.length && blocks[i + run] === v && run < 0xffff) run++;
    writeVarint(out, (run << 8) | v);
    i += run;
  }
  return bytesToBase64(new Uint8Array(out));
}

export function rleDecode(text: string): Uint8Array {
  const raw = base64ToBytes(text);
  const out = new Uint8Array(CHUNK_AREA);
  let o = 0;
  let i = 0;
  while (i < raw.length) {
    const { value, next } = readVarint(raw, i);
    i = next;
    const run = value >>> 8;
    const v = value & 0xff;
    if (run === 0 || o + run > CHUNK_AREA) throw new Error('RLE 长度非法');
    out.fill(v, o, o + run);
    o += run;
  }
  if (o !== CHUNK_AREA) throw new Error(`RLE 解码长度不对：${o} ≠ ${CHUNK_AREA}`);
  return out;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function bytesToBase64(buf: Uint8Array): string {
  let out = '';
  for (let i = 0; i < buf.length; i += 3) {
    const a = buf[i];
    const b = i + 1 < buf.length ? buf[i + 1] : 0;
    const c = i + 2 < buf.length ? buf[i + 2] : 0;
    out += B64[a >> 2];
    out += B64[((a & 3) << 4) | (b >> 4)];
    if (i + 1 < buf.length) out += B64[((b & 15) << 2) | (c >> 6)];
    if (i + 2 < buf.length) out += B64[c & 63];
  }
  return out;
}

export function base64ToBytes(text: string): Uint8Array {
  const clean = text.replace(/=+$/, '');
  const bytes: number[] = [];
  let bits = 0;
  let acc = 0;
  for (const ch of clean) {
    const v = B64.indexOf(ch);
    if (v < 0) throw new Error('RLE 含非法字符');
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((acc >> bits) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

// ── 导出 / 导入 ─────────────────────────────────────────

export function makeSaveFile(meta: MetaState, chunks: Map<string, Uint8Array>, ver: string): SaveFile {
  const list: ChunkSave[] = [];
  for (const [key, blocks] of chunks) {
    const [cx, cy] = key.split(',').map(Number);
    list.push({ cx, cy, rle: rleEncode(blocks) });
  }
  list.sort((a, b) => a.cx - b.cx || a.cy - b.cy);
  return {
    app: APP_ID,
    fmt: SAVE_FMT,
    ver,
    savedAt: new Date().toISOString(),
    meta: { ...meta, savedAt: new Date().toISOString() },
    chunks: list,
  };
}

export function encodeSave(save: SaveFile, pretty = false): string {
  return JSON.stringify(save, null, pretty ? 1 : 0);
}

export type ImportError =
  | { code: 'NOT_JSON'; detail: string }
  | { code: 'NOT_EARTHENO'; detail: string }
  | { code: 'FMT_TOO_NEW'; detail: string }
  | { code: 'BAD_CHUNK'; detail: string }
  | { code: 'BAD_META'; detail: string };

export type ImportResult =
  | { ok: true; save: SaveFile; chunks: Map<string, Uint8Array>; migratedFrom?: number }
  | { ok: false; error: ImportError };

/** 逐字段重建 —— 每个字段都要有一行，漏登记 = 用户数据悄悄丢失 */
function sanitizeMeta(raw: any): MetaState | null {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.seed !== 'number') return null;
  const p = raw.player ?? {};
  const now = new Date().toISOString();
  return {
    seed: raw.seed >>> 0,
    player: {
      x: num(p.x, 0),
      y: num(p.y, 80),
      facing: p.facing === -1 ? -1 : 1,
      playSec: Math.max(0, Math.floor(num(p.playSec, 0))),
      active: clampInt(p.active, 0, 5, 0),
    },
    inv: sanitizeInventory(raw.inv),
    deepest: num(raw.deepest, 90),
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : now,
    savedAt: typeof raw.savedAt === 'string' ? raw.savedAt : now,
  };
}

function num(v: unknown, def: number): number {
  return typeof v === 'number' && isFinite(v) ? v : def;
}
function clampInt(v: unknown, lo: number, hi: number, def: number): number {
  const n = num(v, def);
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

export function importSave(text: string): ImportResult {
  let raw: any;
  try {
    raw = JSON.parse(text.trim());
  } catch (e) {
    return { ok: false, error: { code: 'NOT_JSON', detail: (e as Error).message } };
  }
  if (!raw || raw.app !== APP_ID) {
    return { ok: false, error: { code: 'NOT_EARTHENO', detail: '这不是《地髓》的存档文件' } };
  }
  if (typeof raw.fmt !== 'number') {
    return { ok: false, error: { code: 'BAD_META', detail: '缺少存档格式号 fmt' } };
  }
  if (raw.fmt > SAVE_FMT) {
    return {
      ok: false,
      error: { code: 'FMT_TOO_NEW', detail: `存档来自更新的版本（fmt ${raw.fmt} > ${SAVE_FMT}），请先更新游戏` },
    };
  }
  const fromFmt = raw.fmt;
  // 迁移链：if (fmt < 2) {...}。目前只有 fmt 1，保留结构供以后扩展。
  let data = raw;

  const meta = sanitizeMeta(data.meta);
  if (!meta) return { ok: false, error: { code: 'BAD_META', detail: '存档缺少世界元数据（meta）' } };

  const chunks = new Map<string, Uint8Array>();
  const list = Array.isArray(data.chunks) ? data.chunks : [];
  for (const c of list) {
    if (!c || typeof c.cx !== 'number' || typeof c.cy !== 'number' || typeof c.rle !== 'string') {
      return { ok: false, error: { code: 'BAD_CHUNK', detail: '有一个区块记录字段不全' } };
    }
    try {
      const blocks = rleDecode(c.rle);
      if (blocks.length !== CHUNK_AREA) throw new Error('长度不对');
      chunks.set(`${c.cx},${c.cy}`, blocks);
    } catch (e) {
      return {
        ok: false,
        error: { code: 'BAD_CHUNK', detail: `区块 (${c.cx},${c.cy}) 数据损坏：${(e as Error).message}` },
      };
    }
  }

  const save: SaveFile = {
    app: APP_ID,
    fmt: SAVE_FMT,
    ver: typeof data.ver === 'string' ? data.ver : '0',
    savedAt: typeof data.savedAt === 'string' ? data.savedAt : meta.savedAt,
    meta,
    chunks: list.map((c: any) => ({ cx: c.cx, cy: c.cy, rle: c.rle })),
  };
  return { ok: true, save, chunks, migratedFrom: fromFmt !== SAVE_FMT ? fromFmt : undefined };
}

/** chunk key */
export function chunkKey(cx: number, cy: number): string {
  return `${cx},${cy}`;
}
export function parseChunkKey(key: string): [number, number] {
  const [a, b] = key.split(',');
  return [Number(a), Number(b)];
}

export { CHUNK };
