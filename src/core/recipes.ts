/**
 * 工具（镐/铲/斧）定义与配方。
 * 工具按「种类 + 等级」区分，同一时间只持有一把当前工具（快捷栏里另存方块）。
 */
import { blockByKey } from './blocks';

export type ToolKind = 'pick' | 'shovel' | 'axe';

export interface ToolDef {
  id: string;
  name: string;
  kind: ToolKind;
  tier: number;
  durability: number;
  /** 挖掘速度倍率 */
  speed: number;
}

export const TOOLS: ToolDef[] = [
  { id: 'pick_stone', name: '石镐', kind: 'pick', tier: 1, durability: 60, speed: 1.0 },
  { id: 'pick_copper', name: '铜镐', kind: 'pick', tier: 2, durability: 140, speed: 1.25 },
  { id: 'pick_glow', name: '青辉镐', kind: 'pick', tier: 3, durability: 320, speed: 1.55 },
  { id: 'shovel_hand', name: '木铲', kind: 'shovel', tier: 0, durability: 40, speed: 1.0 },
  { id: 'shovel_copper', name: '铜铲', kind: 'shovel', tier: 1, durability: 120, speed: 1.3 },
  { id: 'axe_stone', name: '石斧', kind: 'axe', tier: 1, durability: 60, speed: 1.0 },
  { id: 'axe_copper', name: '铜斧', kind: 'axe', tier: 2, durability: 140, speed: 1.3 },
];

const TOOL_BY_ID = new Map(TOOLS.map((t) => [t.id, t]));
export function toolById(id: string | undefined | null): ToolDef | undefined {
  return id ? TOOL_BY_ID.get(id) : undefined;
}

export interface Ingredient {
  /** 方块 key 或工具 id */
  item: string;
  n: number;
}

export interface Recipe {
  id: string;
  /** 产物：方块 key */
  out?: string;
  outN?: number;
  /** 产物：工具 id（与 out 二选一） */
  tool?: string;
  need: Ingredient[];
  hint?: string;
}

export const RECIPES: Recipe[] = [
  {
    id: 'cobble',
    out: 'cobble',
    outN: 1,
    need: [{ item: 'stone', n: 2 }],
    hint: '把岩层敲成规整的砖块',
  },
  {
    id: 'plank',
    out: 'plank',
    outN: 4,
    need: [
      { item: 'wood', n: 2 },
      { item: 'clay', n: 1 },
    ],
    hint: '枯木剖成薄板，抹一层赭泥',
  },
  {
    id: 'brick',
    out: 'brick',
    outN: 2,
    need: [
      { item: 'clay', n: 2 },
      { item: 'ember', n: 1 },
    ],
    hint: '用余烬的热把赭泥烧成陶砖',
  },
  {
    id: 'torch',
    out: 'torch',
    outN: 4,
    need: [
      { item: 'wood', n: 2 },
      { item: 'ember', n: 1 },
    ],
    hint: '照亮矿洞的唯一办法。也可以先把火把放进快捷栏——举着它同样看得更远',
  },
  {
    id: 'shovel_hand',
    tool: 'shovel_hand',
    need: [
      { item: 'wood', n: 2 },
      { item: 'cobble', n: 1 },
    ],
    hint: '挖赭泥快得多',
  },
  {
    id: 'pick_stone',
    tool: 'pick_stone',
    need: [
      { item: 'cobble', n: 3 },
      { item: 'wood', n: 2 },
    ],
    hint: '能挖动岩层，一切从这里开始',
  },
  {
    id: 'axe_stone',
    tool: 'axe_stone',
    need: [
      { item: 'cobble', n: 2 },
      { item: 'wood', n: 2 },
    ],
    hint: '砍枯木更快',
  },
  {
    id: 'pick_copper',
    tool: 'pick_copper',
    need: [
      { item: 'copper', n: 3 },
      { item: 'wood', n: 2 },
      { item: 'pick_stone', n: 1 },
    ],
    hint: '需要一把石镐作为替换（会消耗）',
  },
  {
    id: 'shovel_copper',
    tool: 'shovel_copper',
    need: [
      { item: 'copper', n: 2 },
      { item: 'wood', n: 2 },
    ],
    hint: '快铲',
  },
  {
    id: 'axe_copper',
    tool: 'axe_copper',
    need: [
      { item: 'copper', n: 2 },
      { item: 'wood', n: 2 },
    ],
    hint: '快斧',
  },
  {
    id: 'pick_glow',
    tool: 'pick_glow',
    need: [
      { item: 'glow', n: 2 },
      { item: 'copper', n: 2 },
      { item: 'wood', n: 2 },
      { item: 'pick_copper', n: 1 },
    ],
    hint: '最深处的青辉晶只有它挖得动。曜岩能用铜镐挖，镐子才转得起来',
  },
  {
    id: 'building_block',
    out: 'plank',
    outN: 4,
    need: [
      { item: 'wood', n: 2 },
      { item: 'dirt', n: 1 },
    ],
    hint: '不挖赭泥也能拿到香板：木头 + 夯土压实（造房子用）',
  },
];

export function recipeById(id: string): Recipe | undefined {
  return RECIPES.find((r) => r.id === id);
}

/** 配方里出现的方块必须真实存在 —— 防止改名后静默失效 */
export function validateRecipes(): string[] {
  const errs: string[] = [];
  for (const r of RECIPES) {
    if (r.out && !blockByKey(r.out)) errs.push(`${r.id}: 产物方块不存在 ${r.out}`);
    if (r.tool && !toolById(r.tool)) errs.push(`${r.id}: 产物工具不存在 ${r.tool}`);
    for (const ing of r.need) {
      if (!blockByKey(ing.item) && !toolById(ing.item)) errs.push(`${r.id}: 材料不存在 ${ing.item}`);
    }
  }
  return errs;
}
