/**
 * 世界地形生成 —— 纯函数。
 *
 * 关键约束：**确定性**。存档只记录玩家改动过的 chunk，没改过的读档时按种子重新生成，
 * 所以「同种子 × 同坐标」必须永远得到同一份字节。任何改动生成器的行为都等于改了老存档的地形，
 * 要动就抬 SAVE_FMT 并写迁移。
 */
import { AIR, BEDROCK, idOf } from './blocks';
import { CHUNK, CHUNK_AREA, WORLD } from './constants';
import { fbm, fbm1, valueNoise } from './noise';
import { rngAt } from './rng';

export const SEA_LEVEL = 84;

const ID = {
  grass: idOf('grass'),
  dirt: idOf('dirt'),
  stone: idOf('stone'),
  clay: idOf('clay'),
  flint: idOf('flint'),
  copper: idOf('copper'),
  ember: idOf('ember'),
  glow: idOf('glow'),
  wood: idOf('wood'),
  crystal: idOf('crystal'),
  obsidian: idOf('obsidian'),
  bedrock: BEDROCK,
};

/**
 * 把 fbm 输出重新摊开。
 *
 * 踩过的坑：4 个 octave 叠出来的值会向 0.5 集中，实测只有 0.37–0.58 这么窄一段（±0.1），
 * 乘上振幅后整片地表只有 3 格起伏 —— 画面上就是一条俯视看着很"平"的长带。
 * 这里做一次以 0.5 为中心、倍率 k 的拉伸再夹住，让 0.4–0.6 映射到 0.15–0.85。
 */
function stretch(v: number, k: number): number {
  return Math.max(0, Math.min(1, (v - 0.5) * k + 0.5));
}

/** 某个 tile 列的地表高度（该列第一个实心 tile 的 y） */
export function surfaceY(seed: number, x: number): number {
  const n = stretch(fbm1(seed ^ 0x5bd1e995, x * 0.012, { octaves: 4, gain: 0.5, lacunarity: 2 }), 2.6);
  const hill = stretch(fbm1(seed ^ 0x27d4eb2d, x * 0.004, { octaves: 2 }), 2.2);
  // 高频的小碎屑：让地表有 1 格级别的不平整，站上去不至于像走平地
  const rough = (valueNoise(seed ^ 0x1357, x * 0.35, 0.5) - 0.5) * 1.6;
  return Math.round(SEA_LEVEL - 10 - (n - 0.5) * 26 - (hill - 0.5) * 22 + rough);
}

/** 洞穴：两层不同频率噪声的"等值线带"取交集 → 连续隧道，而不是满天麻点 */
export function isCave(seed: number, x: number, y: number): boolean {
  // 只在地下深处开洞：洞口永远在地表以下至少 8 格，避免把草皮啃出一个个坑
  if (y < surfaceY(seed, x) + 8) return false;
  const depth = Math.min(1, (y - SEA_LEVEL) / 70);
  const n1 = valueNoise(seed ^ 0x1111, x * 0.035, y * 0.05);
  const n2 = valueNoise(seed ^ 0x2222, x * 0.055, y * 0.028);
  const band = 0.042 + 0.022 * depth;
  const a = Math.abs(n1 - 0.5) < band;
  const b = Math.abs(n2 - 0.5) < band * 1.15;
  return a && b;
}

/** 矿脉：低频斑块噪声超过阈值处成团出现 */
function veinAt(seed: number, x: number, y: number, salt: number, freq: number, threshold: number): boolean {
  return valueNoise(seed ^ salt, x * freq, y * freq) > threshold;
}

function fillColumn(seed: number, x: number, out: Uint8Array, cy: number, rand: () => number) {
  const top = surfaceY(seed, x);
  const base = cy * CHUNK;
  for (let iy = 0; iy < CHUNK; iy++) {
    const y = base + iy;
    const idx = iy * CHUNK + (x & 31);
    let id: number;
    if (y < top) id = AIR;
    else if (y <= top + 1) id = ID.grass;
    else if (y <= top + 4) id = ID.dirt;
    else if (y >= 158) id = ID.bedrock;
    else {
      // 岩层主体
      id = ID.stone;
      // 赭泥团块（较浅处）
      if (y < 112 && veinAt(seed, x, y, 0x3333, 0.07, 0.68)) id = ID.clay;
      // 燧石（深层）
      else if (y >= 104 && veinAt(seed, x, y, 0x4444, 0.11, 0.74)) id = ID.flint;
      // 铜脉（中层偏下）
      else if (y >= 96 && y < 140 && veinAt(seed, x, y, 0x5555, 0.13, 0.80)) id = ID.copper;
      // 余烬石（深层，稀有）
      else if (y >= 118 && veinAt(seed, x, y, 0x6666, 0.16, 0.86)) id = ID.ember;
      // 青辉晶（极深、极稀疏）
      else if (y >= 138 && veinAt(seed, x, y, 0x7777, 0.2, 0.9)) id = ID.glow;
      // 曜岩（深处、成片）：通往青辉镐的踏板，出现得比青辉晶勤快得多
      else if (y >= 126 && veinAt(seed, x, y, 0x9999, 0.17, 0.82)) id = ID.obsidian;
      // 晶壁（洞穴边缘的装饰，在挖洞之后填）
      // 灰噪：让大片纯色有少许变化
      else if (rand() < 0.06) id = ID.stone;
    }
    out[idx] = id;
  }
}

function carveCaves(seed: number, cx: number, out: Uint8Array) {
  const bx = cx * CHUNK;
  const base = 0;
  for (let iy = 0; iy < CHUNK; iy++) {
    const y = base + iy;
    for (let ix = 0; ix < CHUNK; ix++) {
      const x = bx + ix;
      const idx = iy * CHUNK + ix;
      if (out[idx] === AIR || out[idx] === ID.bedrock) continue;
      if (!isCave(seed, x, y)) continue;
      out[idx] = AIR;
      // 洞口内壁偶发晶壁
      if (y > 120 && valueNoise(seed ^ 0x8888, x * 0.3, y * 0.3) > 0.86) out[idx] = ID.crystal;
    }
  }
}

/** 清理孤立单块（四邻居全空气），减少视觉噪点 —— 只处理 chunk 内部，避免跨 chunk 依赖 */
function cleanFloating(out: Uint8Array) {
  const src = out.slice();
  for (let iy = 1; iy < CHUNK - 1; iy++) {
    for (let ix = 1; ix < CHUNK - 1; ix++) {
      const idx = iy * CHUNK + ix;
      const v = src[idx];
      if (v === AIR || v === ID.bedrock) continue;
      if (
        src[idx - 1] === AIR &&
        src[idx + 1] === AIR &&
        src[idx - CHUNK] === AIR &&
        src[idx + CHUNK] === AIR
      ) {
        out[idx] = AIR;
      }
    }
  }
}

/** 地表植生：枯木柱 + 少量晶簇。用独立 PRNG 逐列判定，保证与遍历顺序无关。 */
function decorate(seed: number, cx: number, out: Uint8Array) {
  const bx = cx * CHUNK;
  for (let ix = 0; ix < CHUNK; ix++) {
    const x = bx + ix;
    const r = rngAt(seed ^ 0x9e3779b9, x, 0);
    const top = surfaceY(seed, x);
    const iy = top - 1;
    if (iy < 0 || iy >= CHUNK) continue;
    if (out[iy * CHUNK + ix] !== ID.grass) continue;
    if (r() < 0.07) {
      const h = 2 + Math.floor(r() * 3);
      for (let k = 1; k <= h; k++) {
        const yy = iy - k;
        if (yy >= 0 && out[yy * CHUNK + ix] === AIR) out[yy * CHUNK + ix] = ID.wood;
      }
    }
  }
}

/** 出生点：x ∈ [-6, 6] 范围内最高的地表，附近从简（削平），清出站立空间 */
export function findSpawn(seed: number): { x: number; y: number } {
  let bestX = 0;
  let bestTop = Number.MAX_SAFE_INTEGER;
  for (let x = -6; x <= 6; x++) {
    const t = surfaceY(seed, x);
    if (t < bestTop) {
      bestTop = t;
      bestX = x;
    }
  }
  return { x: bestX + 0.5, y: bestTop };
}

/**
 * 生成一个 chunk。
 * @returns 1024 字节的方块 id 数组（行优先，索引 iy*32+ix）
 */
export function generateChunk(seed: number, cx: number, cy: number): Uint8Array {
  const out = new Uint8Array(CHUNK_AREA);
  if (cy < WORLD.cyMin || cy > WORLD.cyMax || cx < WORLD.cxMin || cx > WORLD.cxMax) {
    out.fill(ID.bedrock);
    return out;
  }
  // 头顶那两行空气：显式判一下，免得以后有人把地表高度调到 0 附近时
  // 出现"天空里飘着土"的诡异画面（老存档则已由 SAVE_FMT 2 迁移把这两行清空）
  if (cy < 0) return out;
  // 该 chunk 若完全高于地表，直接全空
  let minSurface = Infinity;
  for (let ix = 0; ix < CHUNK; ix++) minSurface = Math.min(minSurface, surfaceY(seed, cx * CHUNK + ix));
  if ((cy + 1) * CHUNK <= minSurface) return out;

  const rand = rngAt(seed, cx, cy + 1000);
  for (let ix = 0; ix < CHUNK; ix++) fillColumn(seed, cx * CHUNK + ix, out, cy, rand);
  carveCaves(seed, cx, out);
  cleanFloating(out);
  decorate(seed, cx, out);

  // 出生点附近的"安全垫"：清掉出生位置上方的方块，保证能站起来
  const spawn = findSpawn(seed);
  const sx = Math.floor(spawn.x);
  if (cx === Math.floor(sx / CHUNK)) {
    const lx = sx - cx * CHUNK;
    for (let k = 1; k <= 3; k++) {
      const y = Math.floor(spawn.y) - k + 1;
      if (y >= cy * CHUNK && y < (cy + 1) * CHUNK) {
        out[(y - cy * CHUNK) * CHUNK + lx] = AIR;
        out[(y - cy * CHUNK) * CHUNK + lx + 1] = AIR;
      }
    }
  }
  return out;
}
