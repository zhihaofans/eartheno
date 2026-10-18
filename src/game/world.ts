/**
 * 沙盒世界状态（与渲染无关）。
 * - chunk 按需生成并缓存；改动过的 chunk 进 dirty 集合等待落库
 * - get/setBlock 是世界唯一的读写入口（渲染层也走这里）
 */
import { AIR, blockById, blockByKey } from '../core/blocks';
import { CHUNK, CHUNK_AREA, WORLD } from '../core/constants';
import type { SolidFn } from '../core/physics';
import { chunkKey } from '../core/save';
import { generateChunk } from '../core/terrain';

export interface ChunkEdit {
  key: string;
  blocks: Uint8Array;
}

export class World {
  readonly seed: number;
  private cache = new Map<string, Uint8Array>();
  /** 有改动、待落库的 chunk */
  private dirty = new Set<string>();
  /** chunk 键 → 生成器给的原始字节（第一次生成时顺手存一份，用于迁移比对） */
  private pristine = new Map<string, Uint8Array>();

  constructor(seed: number, initial: Map<string, Uint8Array> = new Map()) {
    this.seed = seed;
    // 从存档载入的 chunk 视为干净
    for (const [k, v] of initial) this.cache.set(k, v);
  }

  inBounds(cx: number, cy: number): boolean {
    return cx >= WORLD.cxMin && cx <= WORLD.cxMax && cy >= WORLD.cyMin && cy <= WORLD.cyMax;
  }

  getChunk(cx: number, cy: number): Uint8Array | null {
    if (!this.inBounds(cx, cy)) return null;
    const k = chunkKey(cx, cy);
    let c = this.cache.get(k);
    if (!c) {
      c = generateChunk(this.seed, cx, cy);
      this.cache.set(k, c);
    }
    return c;
  }

  /** 生成器对该 chunk 的"原始"结果（不破坏玩家改动）。只有被生成过才有 */
  pristineChunk(cx: number, cy: number): Uint8Array | null {
    if (!this.inBounds(cx, cy)) return null;
    const k = chunkKey(cx, cy);
    let p = this.pristine.get(k);
    if (!p) {
      p = generateChunk(this.seed, cx, cy);
      this.pristine.set(k, p);
    }
    return p;
  }

  /** 已在内存中的 chunk（不改动、不生成） */
  peekChunk(cx: number, cy: number): Uint8Array | null {
    return this.cache.get(chunkKey(cx, cy)) ?? null;
  }

  /**
   * 整块空气？（全空气的 chunk 不建渲染视图，省掉一张 512×512 canvas）
   * 只看内存里的：没生成过 = 还没被看过 = 不需要现在生成。
   */
  isChunkEmpty(cx: number, cy: number): boolean {
    const c = this.peekChunk(cx, cy);
    if (!c) return false;
    for (let i = 0; i < c.length; i++) if (c[i] !== AIR) return false;
    return true;
  }

  getBlock(tx: number, ty: number): number {
    if (ty < WORLD.cyMin * CHUNK || ty >= (WORLD.cyMax + 1) * CHUNK) return AIR;
    const cx = Math.floor(tx / CHUNK);
    const cy = Math.floor(ty / CHUNK);
    if (!this.inBounds(cx, cy)) return 15; // 界外是界石
    const c = this.getChunk(cx, cy);
    if (!c) return AIR;
    const ix = tx - cx * CHUNK;
    const iy = ty - cy * CHUNK;
    return c[iy * CHUNK + ix];
  }

  /** 写入方块。返回是否真的变化（相同值不标脏） */
  setBlock(tx: number, ty: number, id: number): boolean {
    const cx = Math.floor(tx / CHUNK);
    const cy = Math.floor(ty / CHUNK);
    if (!this.inBounds(cx, cy)) return false;
    const c = this.getChunk(cx, cy)!;
    const ix = tx - cx * CHUNK;
    const iy = ty - cy * CHUNK;
    const idx = iy * CHUNK + ix;
    if (c[idx] === id) return false;
    c[idx] = id;
    this.dirty.add(chunkKey(cx, cy));
    return true;
  }

  isSolid: SolidFn = (tx, ty) => blockById(this.getBlock(tx, ty)).solid;

  /** 取出待落库的 chunk（不清空 dirty，落库成功后再 ack） */
  dirtyEdits(): ChunkEdit[] {
    const out: ChunkEdit[] = [];
    for (const key of this.dirty) {
      const c = this.cache.get(key);
      if (c) out.push({ key, blocks: c.slice() });
    }
    return out;
  }

  /** 全部已改动 chunk（导存档用，不受 dirty 清空影响） */
  allEdits(): Map<string, Uint8Array> {
    const m = new Map<string, Uint8Array>();
    for (const key of this.dirty) {
      const c = this.cache.get(key);
      if (c) m.set(key, c);
    }
    return m;
  }

  ack(keys: string[]): void {
    for (const k of keys) this.dirty.delete(k);
  }

  /**
   * 把一个"和原版生成结果不同"的 chunk 收进来，并标记为待落库。
   * 用途：老存档迁移（补天空行、修天空里异常生成的土）。
   */
  adoptEdit(key: string, blocks: Uint8Array): void {
    this.cache.set(key, blocks);
    this.dirty.add(key);
  }

  get dirtyCount(): number {
    return this.dirty.size;
  }

  /** 内存里的 chunk 数量（调试用） */
  get cacheSize(): number {
    return this.cache.size;
  }

  /** 放置规则：目标为空气且可放置 */
  canPlace(tx: number, ty: number): boolean {
    return this.getBlock(tx, ty) === AIR;
  }

  static idOf(key: string): number {
    return blockByKey(key)?.id ?? AIR;
  }

  static readonly CHUNK_AREA = CHUNK_AREA;
}
