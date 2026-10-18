import { describe, it, expect } from 'vitest';
import { CHUNK, WORLD } from '../../src/core/constants';
import { surfaceY, isCave, generateChunk, findSpawn } from '../../src/core/terrain';
import { AIR, BEDROCK, idOf } from '../../src/core/blocks';

const SEEDS = [1, 0x1a2b3c4d, 987654321];

function at(buf: Uint8Array, lx: number, ly: number): number {
  return buf[ly * CHUNK + lx];
}

/** chunk 一定在世界范围内才可比较 */
function safeChunk(seed: number, cx: number, cy: number) {
  return generateChunk(seed, cx, cy);
}

describe('地形生成', () => {
  it('同种子同坐标 → 字节完全一致（存档只存 diff 的前提）', () => {
    for (const seed of SEEDS) {
      const a = generateChunk(seed, 0, 2);
      const b = generateChunk(seed, 0, 2);
      expect(Array.from(a)).toEqual(Array.from(b));
    }
  });

  it('不同种子 → 地形不同', () => {
    expect(Array.from(generateChunk(1, 0, 2))).not.toEqual(Array.from(generateChunk(2, 0, 2)));
  });

  it('chunk 尺寸恒为 32×32', () => {
    expect(generateChunk(1, 0, 0)).toHaveLength(CHUNK * CHUNK);
  });

  it('地表以上全是空气', () => {
    const seed = 0x1a2b3c4d;
    for (let cx = -2; cx <= 2; cx++) {
      const chunk = safeChunk(seed, cx, 2);
      for (let lx = 0; lx < CHUNK; lx++) {
        const top = surfaceY(seed, cx * CHUNK + lx);
        const ly = top - 2 * CHUNK; // 该列地表在本 chunk 内的行号
        for (let y = 0; y < Math.min(ly, CHUNK); y++) expect(at(chunk, lx, y)).toBe(AIR);
      }
    }
  });

  it('地表两层苔土、接着三层夯土', () => {
    const seed = 0x1a2b3c4d;
    const grass = idOf('grass');
    const dirt = idOf('dirt');
    let checked = 0;
    for (let cx = -2; cx <= 2; cx++) {
      for (let lx = 0; lx < CHUNK; lx++) {
        const top = surfaceY(seed, cx * CHUNK + lx);
        // chunk 一定要按"地表自己所在的那一行"取 —— 固定 cy=2 会拿错块，
        // 地表一旦爬到 y<64 就整片读到空气，测试会假失败。
        const cy = Math.floor(top / CHUNK);
        const chunk = safeChunk(seed, cx, cy);
        const ly = top - cy * CHUNK;
        // 只断言完整落在本 chunk 内的那一段（跨块的下层去下一块看）
        if (ly + 4 >= CHUNK) continue;
        // 生成器会把出生点上方 3 格清空（安全垫），那几列不参与地层断言
        const sx = Math.floor(findSpawn(seed).x);
        if (lx + cx * CHUNK >= sx - 1 && lx + cx * CHUNK <= sx + 2) continue;
        expect(at(chunk, lx, ly)).toBe(grass);
        expect(at(chunk, lx, ly + 1)).toBe(grass);
        expect(at(chunk, lx, ly + 2)).toBe(dirt);
        expect(at(chunk, lx, ly + 4)).toBe(dirt);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(10);
  });

  it('世界底部是界石（挖不动）', () => {
    const chunk = generateChunk(1, 0, 5); // y ∈ [160,192)
    for (let lx = 0; lx < CHUNK; lx += 7) expect(at(chunk, lx, 0)).toBe(BEDROCK);
  });

  it('洞穴不会咬穿地表：地表往下 6 格内没有空气（植生与出生点清理除外）', () => {
    const seed = 0x1a2b3c4d;
    for (let cx = -8; cx <= 8; cx++) {
      for (let cy = 2; cy <= 3; cy++) {
        const chunk = safeChunk(seed, cx, cy);
        for (let lx = 0; lx < CHUNK; lx++) {
          const worldX = cx * CHUNK + lx;
          const top = surfaceY(seed, worldX);
          for (let d = 1; d <= 6; d++) {
            const y = top + d;
            const ly = y - cy * CHUNK;
            if (ly < 0 || ly >= CHUNK) continue;
            const v = at(chunk, lx, ly);
            // 枯木是装饰方块，允许出现在地表附近
            if (v === idOf('wood')) continue;
            expect(v).not.toBe(AIR);
          }
        }
      }
    }
  });

  it('isCave 在深处密度合理（不是全空也不是全实）', () => {
    const seed = 0x1a2b3c4d;
    let cave = 0;
    let total = 0;
    for (let x = 0; x < 240; x += 3) {
      for (let y = 105; y < 155; y += 2) {
        total++;
        if (isCave(seed, x, y)) cave++;
      }
    }
    const ratio = cave / total;
    expect(ratio).toBeGreaterThan(0.005);
    expect(ratio).toBeLessThan(0.45);
  });

  it('isCave 在地表附近恒为 false', () => {
    for (const seed of SEEDS) {
      for (let x = -40; x <= 40; x += 5) {
        const top = surfaceY(seed, x);
        for (let d = 0; d < 8; d++) expect(isCave(seed, x, top + d)).toBe(false);
      }
    }
  });

  it('地下有矿：岩层/赭泥/燧石/铜脉都能生成出来', () => {
    const found = new Set<number>();
    const seed = 0x1a2b3c4d;
    for (let cx = -4; cx <= 4; cx++) {
      for (let cy = 3; cy <= 5; cy++) for (const v of generateChunk(seed, cx, cy)) found.add(v);
    }
    for (const key of ['stone', 'clay', 'flint', 'copper']) {
      expect(found.has(idOf(key))).toBe(true);
    }
  });

  it('出生点脚下是实心、头顶是空气', () => {
    for (const seed of SEEDS) {
      const spawn = findSpawn(seed);
      expect(Math.abs(spawn.x)).toBeLessThanOrEqual(7);
      const tx = Math.floor(spawn.x);
      const top = surfaceY(seed, tx);
      const cx = Math.floor(tx / CHUNK);
      const cy = Math.floor(top / CHUNK);
      const chunk = generateChunk(seed, cx, cy);
      const lx = tx - cx * CHUNK;
      const ly = top - cy * CHUNK;
      // findSpawn.y 与 body 语义一致：就是"脚底所在的格线"。
      // 人站在 y=top 这条线上，top 那一格本身是空气，往下第一格（ly+1）才是实心；
      // 头顶两格必须也是空气，否则一开局就卡在土里。
      expect(spawn.y).toBe(top);
      expect(at(chunk, lx, ly)).toBe(AIR);
      expect(at(chunk, lx, ly + 1)).not.toBe(AIR);
      expect(at(chunk, lx, ly - 1)).toBe(AIR);
      expect(at(chunk, lx, ly - 2)).toBe(AIR);
    }
  });

  it('世界边界外的 chunk 全是界石（不会走出世界）', () => {
    const out = generateChunk(1, WORLD.cxMax + 1, 0);
    expect(Array.from(new Set(out))).toEqual([BEDROCK]);
    const out2 = generateChunk(1, 0, -1);
    expect(Array.from(new Set(out2))).toEqual([BEDROCK]);
  });
});
