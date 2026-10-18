/**
 * 程序化美术：角色与 UI 图标。
 * 角色用字符串画稿（原作者手绘像素），每帧 12×18。
 */
export type Pixels = { w: number; h: number; data: Uint8ClampedArray };

type Grid = string[];

const C = {
  o: [28, 22, 20], // 描边
  s: [224, 176, 132], // 皮肤
  S: [176, 130, 94], // 皮肤暗部
  h: [40, 44, 58], // 帽檐 / 头发
  c: [58, 132, 118], // 外套（提亮，和苔土地表拉开对比）
  C: [40, 98, 88], // 外套暗部
  b: [92, 72, 52], // 腰带
  p: [54, 58, 72], // 裤子
  k: [34, 32, 38], // 靴子
  w: [206, 214, 228], // 工具金属
} as const;

function gridToPixels(grid: Grid, map: Record<string, readonly number[]>): Pixels {
  const h = grid.length;
  const w = Math.max(...grid.map((r) => r.length));
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ch = grid[y][x];
      const col = map[ch];
      if (!col) continue;
      const i = (y * w + x) * 4;
      data[i] = col[0];
      data[i + 1] = col[1];
      data[i + 2] = col[2];
      data[i + 3] = 255;
    }
  }
  return { w, h, data };
}

// 12 宽 × 18 高。头 7 行 + 身体 6 行 + 腿 5 行。
// 「地髓」的设定是矿脉勘探者：宽檐帽 + 背带裤 + 分开的靴子，
// 剪影三层分明（帽檐横向展开 / 肩膀收窄 / 双脚落地），小尺寸下也能一眼认出。
const HEAD = [
  '..hhhhhhhh..',
  '.hhhhhhhhhh.',
  'hhhhhhhhhhhh',
  '..hhhhhhhh..',
  '..hsssssshh.',
  '..ssoSSoss..',
  '...sSSSSs...',
];
const BODY = [
  '..cccccccc..',
  '.cccccccccc.',
  '.scccCCcccs.',
  '.scccCCcccs.',
  '..bbbbbbbb..',
  '..ssssssss..',
];
const LEGS_STAND = [
  '..pppppppp..',
  '..ppp..ppp..',
  '..ppp..ppp..',
  '..kkk..kkk..',
];
const LEGS_WALK_A = [
  '..pppppppp..',
  '.ppp....ppp.',
  '.pp......pp.',
  'kkk......kkk',
];
const LEGS_WALK_B = [
  '..pppppppp..',
  '...ppp.ppp..',
  '.....p.pp...',
  '.....kkkk...',
];
const LEGS_JUMP = [
  '..pppppppp..',
  '.ppp...ppp..',
  '.kk.....kk..',
  '............',
];

/** 帧 0/1/2 = 站立/走A/走B；3 = 跳；4 = 挖（手臂上抬） */
export const CHAR_FRAMES: Grid[] = [
  [...HEAD, ...BODY, ...LEGS_STAND],
  [...HEAD, ...BODY, ...LEGS_WALK_A],
  [...HEAD, ...BODY, ...LEGS_WALK_B],
  [...HEAD, ...BODY, ...LEGS_JUMP],
  [...HEAD, ...BODY, ...LEGS_STAND],
];

export function buildCharacterFrames(): Pixels[] {
  const map: Record<string, readonly number[]> = C as unknown as Record<string, readonly number[]>;
  return CHAR_FRAMES.map((g) => gridToPixels(g, map));
}

/** 工具图标（14×14），用于背包/合成面板 */
const TOOL_ICON_PICK = [
  '..............',
  '.wwwwwwwwww...',
  'w..........w..',
  '..............',
  '......bb......',
  '.....bb.......',
  '....bb........',
  '...bb.........',
  '..bb..........',
  '.bb...........',
  '.b............',
  '..............',
  '..............',
  '..............',
];
const TOOL_ICON_SHOVEL = [
  '..............',
  '.........ww...',
  '........wwww..',
  '........wwww..',
  '........www...',
  '.......bb.....',
  '......bb......',
  '.....bb.......',
  '....bb........',
  '...bb.........',
  '..bb..........',
  '.bb...........',
  '..............',
  '..............',
];
const TOOL_ICON_AXE = [
  '..............',
  '...wwww.......',
  '..wwwwww......',
  '..wwwwww......',
  '...wwbb.......',
  '.....bb.......',
  '....bb........',
  '...bb.........',
  '..bb..........',
  '.bb...........',
  '.b............',
  '..............',
  '..............',
  '..............',
];

const TOOL_MAP: Record<string, readonly number[]> = {
  w: [206, 212, 224],
  b: [140, 104, 66],
};

export function buildToolIcons(): Record<'pick' | 'shovel' | 'axe', Pixels> {
  return {
    pick: gridToPixels(TOOL_ICON_PICK, TOOL_MAP),
    shovel: gridToPixels(TOOL_ICON_SHOVEL, TOOL_MAP),
    axe: gridToPixels(TOOL_ICON_AXE, TOOL_MAP),
  };
}

/** 简单径向光晕（64×64），光源与 UI 共享 */
export function makeGlow(radiusPx = 32, color: [number, number, number] = [255, 190, 110]): Pixels {
  const w = radiusPx * 2;
  const data = new Uint8ClampedArray(w * w * 4);
  for (let y = 0; y < w; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (x - radiusPx) / radiusPx;
      const dy = (y - radiusPx) / radiusPx;
      const d = Math.sqrt(dx * dx + dy * dy);
      const a = d >= 1 ? 0 : Math.pow(1 - d, 2.2);
      const i = (y * w + x) * 4;
      data[i] = color[0];
      data[i + 1] = color[1];
      data[i + 2] = color[2];
      data[i + 3] = a * 255;
    }
  }
  return { w, h: w, data };
}
