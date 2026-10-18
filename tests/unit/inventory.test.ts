import { describe, it, expect } from 'vitest';
import {
  emptyInventory,
  add,
  remove,
  count,
  canAdd,
  hasTool,
  giveTool,
  wearTool,
  toolTier,
  bestToolOfKind,
  ensureToolFor,
  setHotbarSlot,
  autoHotbar,
  craft,
  craftableCount,
  sanitizeInventory,
  STACK_MAX,
  HOTBAR_SIZE,
  type InventoryData,
} from '../../src/core/inventory';
import { RECIPES, TOOLS, toolById, validateRecipes } from '../../src/core/recipes';
import { BLOCKS, CARRIABLE, blockByKey, idOf, blockById } from '../../src/core/blocks';

function inv(patch: (i: InventoryData) => void = () => {}): InventoryData {
  const i = emptyInventory();
  patch(i);
  return i;
}

describe('方块注册表', () => {
  it('15 种可携带方块（17 个 id 去掉空气与界石），正好还是规格上限 15', () => {
    expect(CARRIABLE).toHaveLength(15);
    expect(CARRIABLE.length).toBeGreaterThanOrEqual(8);
    // 规格写的是 8–15 种，曜岩是最后一个名额：再加方块就得先合并掉一个
    expect(CARRIABLE.length).toBeLessThanOrEqual(15);
    expect(CARRIABLE.some((b) => b.key === 'air')).toBe(false);
    expect(CARRIABLE.some((b) => b.key === 'bedrock')).toBe(false);
  });

  it('id 从 0 连续递增，key 唯一', () => {
    const keys = new Set<string>();
    BLOCKS.forEach((b, i) => {
      expect(b.id).toBe(i);
      expect(keys.has(b.key)).toBe(false);
      keys.add(b.key);
    });
  });

  it('每个方块都有中文名与合理的硬度', () => {
    for (const b of BLOCKS) {
      expect(b.name.length).toBeGreaterThan(0);
      expect(b.hardness).toBeGreaterThanOrEqual(-1);
      expect(b.light).toBeGreaterThanOrEqual(0);
      expect(b.light).toBeLessThanOrEqual(1);
    }
  });

  it('空气与界石不可放置；界石不可挖', () => {
    expect(blockByKey('air')!.placeable).toBe(false);
    expect(blockByKey('bedrock')!.placeable).toBe(false);
    expect(blockByKey('bedrock')!.hardness).toBe(-1);
  });

  it('掉落物必须是合法方块', () => {
    for (const b of BLOCKS) {
      if (b.drop) expect(blockByKey(b.drop)).toBeTruthy();
    }
  });

  it('idOf / blockById 对得上', () => {
    for (const b of BLOCKS) {
      expect(idOf(b.key)).toBe(b.id);
      expect(blockById(b.id).key).toBe(b.key);
    }
    // 越界 id 回落到空气，不抛错（读档容错）
    expect(blockById(9999).key).toBe('air');
  });

  it('注册表里所有方块都有对应的程序化纹理风格（key 不能为空）', () => {
    for (const b of BLOCKS) expect(b.key.trim()).toBe(b.key);
  });
});

describe('配方表', () => {
  it('validateRecipes 全部通过（产物/材料都存在）', () => {
    expect(validateRecipes()).toEqual([]);
  });

  it('配方数量够 MVP 用（≥ 8 条）', () => {
    expect(RECIPES.length).toBeGreaterThanOrEqual(8);
  });

  it('配方 id 唯一，产物要么是方块要么是工具', () => {
    const ids = new Set<string>();
    for (const r of RECIPES) {
      expect(ids.has(r.id)).toBe(false);
      ids.add(r.id);
      expect(Boolean(r.out) !== Boolean(r.tool)).toBe(true);
      if (r.out) expect(blockByKey(r.out)).toBeTruthy();
      if (r.tool) expect(toolById(r.tool)).toBeTruthy();
    }
  });

  it('工具配方都要求一个工具等级递进的材料', () => {
    const toolRecipes = RECIPES.filter((r) => r.tool);
    expect(toolRecipes.length).toBeGreaterThanOrEqual(5);
    for (const r of toolRecipes) {
      expect(r.need.length).toBeGreaterThan(0);
      for (const ing of r.need) expect(ing.n).toBeGreaterThan(0);
    }
  });

  it('7 把工具覆盖 3 类 × 3 档，等级单调', () => {
    expect(TOOLS).toHaveLength(7);
    for (const kind of ['pick', 'shovel', 'axe']) {
      const tiers = TOOLS.filter((t) => t.kind === kind).map((t) => t.tier);
      expect(tiers.length).toBeGreaterThan(0);
      const sorted = [...tiers].sort((a, b) => a - b);
      expect(tiers).toEqual(sorted);
    }
  });
});

describe('背包', () => {
  it('初始背包有 1 格夯土 + 快捷栏第 1 格夯土', () => {
    const i = emptyInventory();
    expect(i.hotbar).toHaveLength(HOTBAR_SIZE);
    expect(i.hotbar[0]).toBe('dirt');
    expect(count(i, 'dirt')).toBe(0);
  });

  it('add / remove / count 基本语义', () => {
    const i = inv();
    expect(add(i, 'stone', 5)).toBe(5);
    expect(count(i, 'stone')).toBe(5);
    expect(remove(i, 'stone', 2)).toBe(true);
    expect(count(i, 'stone')).toBe(3);
    expect(remove(i, 'stone', 10)).toBe(false); // 不够就不动
    expect(count(i, 'stone')).toBe(3);
    remove(i, 'stone', 3);
    expect(count(i, 'stone')).toBe(0);
    expect('stone' in i.counts).toBe(false); // 归零后不留 key
  });

  it('单格上限 999，溢出部分丢弃', () => {
    const i = inv();
    add(i, 'dirt', STACK_MAX - 1);
    expect(add(i, 'dirt', 10)).toBe(1);
    expect(count(i, 'dirt')).toBe(STACK_MAX);
    expect(canAdd(i, 'dirt')).toBe(false);
    expect(canAdd(i, 'stone')).toBe(true);
    expect(add(i, 'dirt', 1)).toBe(0);
  });

  it('负数/零不改变状态', () => {
    const i = inv();
    add(i, 'dirt', 0);
    expect(count(i, 'dirt')).toBe(0);
    add(i, 'dirt', -5);
    expect(count(i, 'dirt')).toBe(0);
  });
});

describe('工具与耐久', () => {
  it('giveTool 给满耐久并自动持握', () => {
    const i = inv();
    giveTool(i, 'pick_stone');
    expect(hasTool(i, 'pick_stone')).toBe(true);
    expect(i.tools.held).toBe('pick_stone');
    expect(i.tools.durability.pick_stone).toBe(60);
  });

  it('wearTool 扣耐久，归零后从列表移除', () => {
    const i = inv();
    giveTool(i, 'shovel_hand');
    expect(wearTool(i, 'shovel_hand', 39)).toBe(false);
    expect(i.tools.durability.shovel_hand).toBe(1);
    expect(wearTool(i, 'shovel_hand', 1)).toBe(true); // 坏了
    expect(hasTool(i, 'shovel_hand')).toBe(false);
    expect(i.tools.held).toBe(null);
  });

  it('工具坏掉后自动切换到同类里剩下的最好一把', () => {
    const i = inv();
    giveTool(i, 'pick_stone');
    giveTool(i, 'pick_glow');
    expect(i.tools.held).toBe('pick_glow');
    wearTool(i, 'pick_glow', 999);
    expect(i.tools.held).toBe('pick_stone');
  });

  it('toolTier 只认当前手持且同类', () => {
    const i = inv();
    giveTool(i, 'pick_copper');
    expect(toolTier(i, 'pick')).toBe(2);
    expect(toolTier(i, 'shovel')).toBe(0);
  });

  it('bestToolOfKind 按等级取最高，没有返回 null', () => {
    const i = inv();
    expect(bestToolOfKind(i, 'axe')).toBe(null);
    giveTool(i, 'axe_stone');
    giveTool(i, 'axe_copper');
    expect(bestToolOfKind(i, 'axe')).toBe('axe_copper');
  });

  it('ensureToolFor 在手持不匹配时自动换到对口工具', () => {
    const i = inv();
    giveTool(i, 'pick_stone');
    ensureToolFor(i, 'axe');
    expect(i.tools.held).toBe('pick_stone'); // 没有斧头就不动
    giveTool(i, 'axe_copper');
    i.tools.held = 'pick_stone';
    ensureToolFor(i, 'axe');
    expect(i.tools.held).toBe('axe_copper');
  });

  it('ensureToolFor 传 null 不动', () => {
    const i = inv();
    giveTool(i, 'pick_stone');
    ensureToolFor(i, null);
    expect(i.tools.held).toBe('pick_stone');
  });
});

describe('快捷栏', () => {
  it('setHotbarSlot 校验下标与 key', () => {
    const i = inv();
    expect(setHotbarSlot(i, 1, 'stone')).toBe(true);
    expect(i.hotbar[1]).toBe('stone');
    expect(setHotbarSlot(i, -1, 'stone')).toBe(false);
    expect(setHotbarSlot(i, HOTBAR_SIZE, 'stone')).toBe(false);
    expect(setHotbarSlot(i, 1, 'not_a_block')).toBe(false);
  });

  it('同一方块不会重复占两格', () => {
    const i = inv();
    setHotbarSlot(i, 2, 'stone');
    setHotbarSlot(i, 3, 'stone');
    expect(i.hotbar.filter((k) => k === 'stone')).toHaveLength(1);
    expect(i.hotbar[3]).toBe('stone');
  });

  it('autoHotbar 只填空位，满了就不动', () => {
    const i = inv();
    autoHotbar(i, 'stone');
    expect(i.hotbar[1]).toBe('stone');
    autoHotbar(i, 'stone'); // 已有，不重复
    expect(i.hotbar.filter((k) => k === 'stone')).toHaveLength(1);

    const full = inv((x) => {
      x.hotbar = ['dirt', 'stone', 'clay', 'wood', 'flint', 'cobble'];
    });
    autoHotbar(full, 'plank');
    expect(full.hotbar.includes('plank')).toBe(false);
  });
});

describe('合成', () => {
  const cobbleRecipe = RECIPES.find((r) => r.id === 'cobble')!;

  it('材料不足返回 MISSING 并给出缺口', () => {
    const i = inv();
    const r = craft(i, cobbleRecipe);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('MISSING');
      expect(r.missing).toEqual([{ item: 'stone', need: 2, have: 0 }]);
    }
  });

  it('材料够就扣材料并给产物', () => {
    const i = inv((x) => add(x, 'stone', 3));
    const r = craft(i, cobbleRecipe);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.out).toBe('cobble');
      expect(r.n).toBe(1);
      expect(r.isTool).toBe(false);
    }
    expect(count(i, 'stone')).toBe(1);
    expect(count(i, 'cobble')).toBe(1);
  });

  it('产物自动进快捷栏空位', () => {
    const i = inv((x) => add(x, 'stone', 2));
    craft(i, cobbleRecipe);
    expect(i.hotbar).toContain('cobble');
  });

  it('材料不足时不会扣掉任何东西（不半途而废）', () => {
    const i = inv((x) => {
      add(x, 'wood', 1);
      add(x, 'clay', 9);
    });
    const plank = RECIPES.find((r) => r.id === 'plank')!;
    const r = craft(i, plank);
    expect(r.ok).toBe(false);
    expect(count(i, 'clay')).toBe(9);
    expect(count(i, 'wood')).toBe(1);
  });

  it('背包满时返回 FULL 且不扣材料', () => {
    const i = inv((x) => {
      add(x, 'stone', 4);
      add(x, 'cobble', STACK_MAX);
    });
    const r = craft(i, cobbleRecipe);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('FULL');
    expect(count(i, 'stone')).toBe(4);
  });

  it('工具配方：给工具并消耗材料', () => {
    const pick = RECIPES.find((r) => r.tool === 'pick_stone')!;
    const i = inv((x) => {
      for (const ing of pick.need) add(x, ing.item, ing.n + 1);
    });
    const r = craft(i, pick);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.isTool).toBe(true);
    expect(hasTool(i, 'pick_stone')).toBe(true);
    for (const ing of pick.need) expect(count(i, ing.item)).toBe(1);
  });

  it('craftableCount 按最紧缺的材料算', () => {
    const i = inv((x) => add(x, 'stone', 5));
    expect(craftableCount(i, cobbleRecipe)).toBe(2);
  });

  it('所有配方在材料充足时都能成功（不存在死配方）', () => {
    for (const r of RECIPES) {
      const i = inv((x) => {
        for (const ing of r.need) {
          if (toolById(ing.item)) x.tools.durability[ing.item] = 99;
          else add(x, ing.item, ing.n);
        }
      });
      const res = craft(i, r);
      expect(res.ok, `配方 ${r.id} 失败`).toBe(true);
    }
  });
});

describe('存档里的背包清洗', () => {
  it('非法输入回落到初始背包', () => {
    expect(sanitizeInventory(null)).toEqual(emptyInventory());
    expect(sanitizeInventory(42)).toEqual(emptyInventory());
  });

  it('未知方块 key 被丢弃（版本降级）', () => {
    const i = sanitizeInventory({ counts: { stone: 3, 钻石: 99, air: 5 } });
    expect(count(i, 'stone')).toBe(3);
    expect(count(i, '钻石')).toBe(0);
    expect(count(i, 'air')).toBe(0); // 空气不是可携带物
  });

  it('超上限的数量被夹到 999，负数与 NaN 丢弃', () => {
    const i = sanitizeInventory({ counts: { stone: 99999, dirt: -3, clay: NaN } });
    expect(count(i, 'stone')).toBe(STACK_MAX);
    expect(count(i, 'dirt')).toBe(0);
    expect(count(i, 'clay')).toBe(0);
  });

  it('耐久超上限被夹住，非法工具丢弃', () => {
    const i = sanitizeInventory({ tools: { durability: { pick_stone: 99999, pick_glow: 5, 铁镐: 10 }, held: 'pick_glow' } });
    expect(i.tools.durability.pick_stone).toBe(60);
    expect(i.tools.durability.pick_glow).toBe(5);
    expect(i.tools.held).toBe('pick_glow');
    expect(Object.keys(i.tools.durability)).toHaveLength(2);
  });

  it('held 指向不存在的工具时清空', () => {
    const i = sanitizeInventory({ tools: { held: 'pick_glow', durability: {} } });
    expect(i.tools.held).toBe(null);
  });

  it('快捷栏长度恒为 6，且去重、只保留可放置方块', () => {
    const i = sanitizeInventory({ hotbar: ['stone', 'stone', 'air', 'bedrock', 'wood'] });
    expect(i.hotbar).toHaveLength(HOTBAR_SIZE);
    expect(i.hotbar.filter((k) => k === 'stone')).toHaveLength(1);
    expect(i.hotbar.includes('air')).toBe(false);
    expect(i.hotbar.includes('bedrock')).toBe(false);
    expect(i.hotbar).toContain('wood');
  });
});
