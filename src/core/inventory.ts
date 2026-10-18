/**
 * 背包 & 工具状态。
 *
 * 简化决策（MVP）：按方块类型计数，不做堆叠与箱子。
 * 所有变更都走这里的方法 → 变更后自动标脏，存档层只管 flush。
 */
import { CARRIABLE, blockByKey } from './blocks';
import { TOOLS, toolById, type Recipe } from './recipes';

export const STACK_MAX = 999;
export const HOTBAR_SIZE = 6;

export type BlockCounts = Record<string, number>;

export interface ToolState {
  /** 当前手持工具 id（null = 徒手） */
  held: string | null;
  /** 工具耐久表：id → 剩余耐久（同一工具只保留一把） */
  durability: Record<string, number>;
}

export interface InventoryData {
  counts: BlockCounts;
  tools: ToolState;
  /** 快捷栏 6 格，存方块 key；null = 空位 */
  hotbar: (string | null)[];
}

export function emptyInventory(): InventoryData {
  return {
    counts: {},
    tools: { held: null, durability: {} },
    // 新世界：快捷栏放两格夯土方便马上练手，其余空着等玩家挖到自动填充
    hotbar: ['dirt', null, null, null, null, null],
  };
}

export function count(inv: InventoryData, key: string): number {
  return inv.counts[key] ?? 0;
}

export function canAdd(inv: InventoryData, key: string, n = 1): boolean {
  return count(inv, key) + n <= STACK_MAX;
}

/** 返回实际加入的数量（溢出部分丢弃） */
export function add(inv: InventoryData, key: string, n = 1): number {
  const cur = count(inv, key);
  const addN = Math.max(0, Math.min(n, STACK_MAX - cur));
  if (addN > 0) inv.counts[key] = cur + addN;
  return addN;
}

export function remove(inv: InventoryData, key: string, n = 1): boolean {
  const cur = count(inv, key);
  if (cur < n) return false;
  if (cur === n) delete inv.counts[key];
  else inv.counts[key] = cur - n;
  return true;
}

/** 给工具的"拥有"计数也走方块表 —— 工具不在 counts 里，单独用 durability 表表示"拥有" */
export function hasTool(inv: InventoryData, id: string): boolean {
  return typeof inv.tools.durability[id] === 'number';
}

export function giveTool(inv: InventoryData, id: string): void {
  const def = toolById(id);
  if (!def) return;
  inv.tools.durability[id] = def.durability;
  inv.tools.held = id;
}

/** 消耗耐久，返回是否损坏 */
export function wearTool(inv: InventoryData, id: string, amount = 1): boolean {
  const left = inv.tools.durability[id];
  if (typeof left !== 'number') return false;
  const next = left - amount;
  if (next <= 0) {
    delete inv.tools.durability[id];
    if (inv.tools.held === id) inv.tools.held = bestToolOfKind(inv, toolById(id)!.kind);
    return true;
  }
  inv.tools.durability[id] = next;
  return false;
}

/** 当前手持工具能提供的某类工具等级 */
export function toolTier(inv: InventoryData, kind: string): number {
  const held = toolById(inv.tools.held);
  if (held && held.kind === kind) return held.tier;
  return 0;
}

export function bestToolOfKind(inv: InventoryData, kind: string): string | null {
  let best: string | null = null;
  let bestTier = -1;
  for (const t of TOOLS) {
    if (t.kind !== kind) continue;
    if (!hasTool(inv, t.id)) continue;
    if (t.tier > bestTier) {
      best = t.id;
      bestTier = t.tier;
    }
  }
  return best;
}

/** 手持工具与方块需求不匹配时，自动切换成该类工具里最好的一把 */
export function ensureToolFor(inv: InventoryData, kind: string | null): void {
  if (!kind) return;
  const held = toolById(inv.tools.held);
  if (held && held.kind === kind) return;
  const best = bestToolOfKind(inv, kind);
  if (best) inv.tools.held = best;
}

// ── 快捷栏 ──────────────────────────────────────────────

export function setHotbarSlot(inv: InventoryData, slot: number, key: string | null): boolean {
  if (slot < 0 || slot >= HOTBAR_SIZE) return false;
  if (key !== null && !blockByKey(key)) return false;
  // 同一方块不重复占两格
  const exists = inv.hotbar.indexOf(key);
  if (key !== null && exists >= 0) inv.hotbar[exists] = inv.hotbar[slot];
  inv.hotbar[slot] = key;
  return true;
}

/** 新获得一种方块时，若快捷栏有空位则自动放进去 */
export function autoHotbar(inv: InventoryData, key: string): void {
  if (inv.hotbar.includes(key)) return;
  const empty = inv.hotbar.indexOf(null);
  if (empty >= 0) inv.hotbar[empty] = key;
}

// ── 合成 ────────────────────────────────────────────────

export type CraftResult =
  | { ok: true; out: string; n: number; isTool: boolean }
  | { ok: false; code: 'NO_RECIPE' | 'MISSING' | 'FULL'; missing?: { item: string; need: number; have: number }[] };

export function craftableCount(inv: InventoryData, recipe: Recipe): number {
  let n = Infinity;
  for (const ing of recipe.need) {
    const have = blockByKey(ing.item) ? count(inv, ing.item) : hasTool(inv, ing.item) ? 1 : 0;
    n = Math.min(n, Math.floor(have / ing.n));
  }
  return n === Infinity ? 0 : n;
}

export function craft(inv: InventoryData, recipe: Recipe): CraftResult {
  // 先校验材料（一次性检查，避免"扣了一半卡住"）
  const missing: { item: string; need: number; have: number }[] = [];
  for (const ing of recipe.need) {
    const have = blockByKey(ing.item) ? count(inv, ing.item) : hasTool(inv, ing.item) ? 1 : 0;
    if (have < ing.n) missing.push({ item: ing.item, need: ing.n, have });
  }
  if (missing.length) return { ok: false, code: 'MISSING', missing };

  if (recipe.out) {
    if (!canAdd(inv, recipe.out, recipe.outN ?? 1)) return { ok: false, code: 'FULL' };
  }

  // 扣材料
  for (const ing of recipe.need) {
    if (blockByKey(ing.item)) remove(inv, ing.item, ing.n);
    else {
      // 材料是工具：直接消耗掉那一把
      delete inv.tools.durability[ing.item];
      if (inv.tools.held === ing.item) inv.tools.held = null;
    }
  }

  if (recipe.tool) {
    giveTool(inv, recipe.tool);
    return { ok: true, out: recipe.tool, n: 1, isTool: true };
  }
  const out = recipe.out!;
  const n = recipe.outN ?? 1;
  add(inv, out, n);
  autoHotbar(inv, out);
  return { ok: true, out, n, isTool: false };
}

/** 兼容旧存档：确保 hotbar 长度正确、无非法 key */
export function sanitizeInventory(raw: unknown): InventoryData {
  const base = emptyInventory();
  if (!raw || typeof raw !== 'object') return base;
  const r = raw as Partial<InventoryData>;
  if (r.counts && typeof r.counts === 'object') {
    for (const [k, v] of Object.entries(r.counts)) {
      if (!CARRIABLE.some((b) => b.key === k)) continue; // 未知方块丢弃（版本降级时）
      if (typeof v === 'number' && isFinite(v) && v > 0) base.counts[k] = Math.min(STACK_MAX, Math.floor(v));
    }
  }
  if (r.tools && typeof r.tools === 'object') {
    const dur = (r.tools as ToolState).durability;
    if (dur && typeof dur === 'object') {
      for (const [k, v] of Object.entries(dur)) {
        const def = toolById(k);
        if (!def || typeof v !== 'number' || v <= 0) continue;
        base.tools.durability[k] = Math.min(def.durability, Math.floor(v));
      }
    }
    const held = (r.tools as ToolState).held;
    if (held && hasTool(base, held)) base.tools.held = held;
  }
  if (Array.isArray(r.hotbar)) {
    const hb: (string | null)[] = [null, null, null, null, null, null];
    const seen = new Set<string>();
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      const k = r.hotbar[i];
      if (typeof k === 'string' && blockByKey(k)?.placeable && !seen.has(k)) {
        hb[i] = k;
        seen.add(k);
      }
    }
    base.hotbar = hb;
  }
  return base;
}
