/**
 * 方块注册表 —— 单一数据源。
 * 装饰纹理、硬度、工具匹配、掉落、合成、背包渲染全从这里读。
 * 想加一种方块：这里加一行 + 在 art/blocks.ts 里画一张 16×16 模板。
 *
 * 命名全部为原创（中文为主），不使用任何商业作品的专有名词。
 */

export type ToolKind = 'hand' | 'pick' | 'shovel' | 'axe';

export interface BlockDef {
  id: number;
  key: string;
  name: string;
  /** 硬度：挖掘所需秒数的倍数。0 = 一碰就掉；-1 = 不可挖 */
  hardness: number;
  tool: ToolKind;
  /** 所需最低工具等级（0=徒手，1=石制，2=铜制，3=青辉） */
  tier: number;
  /** 挖掉后掉落的方块 key（默认掉自己） */
  drop?: string | null;
  solid: boolean;
  /** 自发光强度 0..1（影响暗部遮罩） */
  light: number;
  /** 是否可被放置（空气、界石不可） */
  placeable: boolean;
}

export const BLOCKS: BlockDef[] = [
  { id: 0, key: 'air', name: '空气', hardness: -1, tool: 'hand', tier: 0, drop: null, solid: false, light: 0, placeable: false },
  { id: 1, key: 'grass', name: '苔土', hardness: 1, tool: 'hand', tier: 0, drop: 'dirt', solid: true, light: 0, placeable: true },
  { id: 2, key: 'dirt', name: '夯土', hardness: 1, tool: 'shovel', tier: 0, solid: true, light: 0, placeable: true },
  { id: 3, key: 'stone', name: '岩层', hardness: 2, tool: 'pick', tier: 1, drop: 'cobble', solid: true, light: 0, placeable: true },
  { id: 4, key: 'cobble', name: '碎石砖', hardness: 2, tool: 'pick', tier: 1, solid: true, light: 0, placeable: true },
  { id: 5, key: 'clay', name: '赭泥', hardness: 1, tool: 'shovel', tier: 0, solid: true, light: 0, placeable: true },
  { id: 6, key: 'brick', name: '陶砖', hardness: 2, tool: 'pick', tier: 1, solid: true, light: 0, placeable: true },
  { id: 7, key: 'wood', name: '枯木', hardness: 1, tool: 'axe', tier: 0, solid: true, light: 0, placeable: true },
  { id: 8, key: 'flint', name: '燧石', hardness: 3, tool: 'pick', tier: 2, solid: true, light: 0, placeable: true },
  { id: 9, key: 'copper', name: '铜脉', hardness: 3, tool: 'pick', tier: 2, solid: true, light: 0, placeable: true },
  { id: 10, key: 'ember', name: '余烬石', hardness: 3, tool: 'pick', tier: 2, solid: true, light: 0.85, placeable: true },
  { id: 11, key: 'glow', name: '青辉晶', hardness: 4, tool: 'pick', tier: 3, solid: true, light: 0.6, placeable: true },
  { id: 12, key: 'plank', name: '香板', hardness: 1, tool: 'axe', tier: 0, solid: true, light: 0, placeable: true },
  { id: 13, key: 'torch', name: '火把', hardness: 0, tool: 'hand', tier: 0, solid: false, light: 1, placeable: true },
  { id: 14, key: 'crystal', name: '晶壁', hardness: 2, tool: 'pick', tier: 1, solid: true, light: 0.15, placeable: true },
  { id: 15, key: 'bedrock', name: '界石', hardness: -1, tool: 'hand', tier: 0, solid: true, light: 0, placeable: false },
  // 深层高密度岩：比青辉晶常见得多，是通往"青辉镐"的踏板。
  // 没有它的话，想挖青辉晶得先有青辉镐 —— 一个死循环（玩家会以为游戏坏了）。
  { id: 16, key: 'obsidian', name: '曜岩', hardness: 4, tool: 'pick', tier: 3, solid: true, light: 0.1, placeable: true },
];

export const AIR = 0;
export const BEDROCK = 15;

const BY_KEY = new Map<string, BlockDef>();
const BY_ID: BlockDef[] = [];
for (const b of BLOCKS) {
  BY_KEY.set(b.key, b);
  BY_ID[b.id] = b;
}

export function blockByKey(key: string): BlockDef | undefined {
  return BY_KEY.get(key);
}

export function blockById(id: number): BlockDef {
  return BY_ID[id] ?? BY_ID[0];
}

export function idOf(key: string): number {
  const b = BY_KEY.get(key);
  if (!b) throw new Error(`未知方块: ${key}`);
  return b.id;
}

/** 背包/快捷栏里可以出现的方块（排除空气与界石） */
export const CARRIABLE: BlockDef[] = BLOCKS.filter((b) => b.placeable);

export const TOOL_INFO: Record<ToolKind, { name: string; speed: Record<number, number> }> = {
  hand: { name: '徒手', speed: { 0: 1.0 } },
  pick: { name: '镐', speed: { 0: 3.0, 1: 3.0, 2: 3.5, 3: 4.0 } },
  shovel: { name: '铲', speed: { 0: 3.0, 1: 3.0, 2: 3.5, 3: 4.0 } },
  axe: { name: '斧', speed: { 0: 3.0, 1: 3.0, 2: 3.5, 3: 4.0 } },
};

/** 某种方块被某个工具挖的速率倍率 */
export function digSpeed(def: BlockDef, tool: ToolKind, tier: number): number {
  const info = TOOL_INFO[tool];
  const base = info.speed[tier] ?? 1.0;
  if (def.tool === 'hand') return tool === 'hand' ? 1.0 : 1.6;
  // 工具对口 → 全速；不对口 → 手刨
  if (def.tool === tool) return base;
  return 0.8;
}
