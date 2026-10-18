import { describe, it, expect } from 'vitest';
import { valueNoise, fbm, fbm1 } from '../../src/core/noise';

describe('噪声', () => {
  it('valueNoise 输出恒在 [0,1)', () => {
    for (let i = 0; i < 500; i++) {
      const v = valueNoise(7, i * 0.37, i * 1.13);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('valueNoise 在格点上等于 lattice 值，因此同点同值', () => {
    expect(valueNoise(11, 3, 4)).toBe(valueNoise(11, 3, 4));
    expect(valueNoise(11, 3.5, 4)).toBeCloseTo(valueNoise(11, 3.5, 4), 12);
  });

  it('valueNoise 连续：相邻采样差值很小', () => {
    let maxJump = 0;
    for (let x = 0; x < 60; x += 0.05) {
      maxJump = Math.max(maxJump, Math.abs(valueNoise(3, x, 1.5) - valueNoise(3, x + 0.05, 1.5)));
    }
    expect(maxJump).toBeLessThan(0.1);
  });

  it('不同种子给出不同地形', () => {
    const a = Array.from({ length: 32 }, (_, i) => valueNoise(1, i * 0.3, 0.7));
    const b = Array.from({ length: 32 }, (_, i) => valueNoise(2, i * 0.3, 0.7));
    expect(a).not.toEqual(b);
  });

  it('period 让噪声在 X 方向无缝循环', () => {
    const p = 8;
    for (let x = 0; x < 8; x += 0.25) {
      expect(valueNoise(5, x, 0.3, p)).toBeCloseTo(valueNoise(5, x + p, 0.3, p), 10);
    }
  });

  it('fbm 输出落在 [0,1) 且方差合理（不是常数）', () => {
    const vals: number[] = [];
    for (let i = 0; i < 400; i++) vals.push(fbm(9, i * 0.11, i * 0.07));
    for (const v of vals) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const spread = Math.max(...vals) - Math.min(...vals);
    expect(mean).toBeGreaterThan(0.2);
    expect(mean).toBeLessThan(0.8);
    expect(spread).toBeGreaterThan(0.15);
  });

  it('fbm 层数增加会带来更多细节（高频能量更大）', () => {
    const detail = (octaves: number) => {
      let sum = 0;
      let prev = fbm(13, 0, 0, { octaves });
      for (let x = 0.05; x < 40; x += 0.05) {
        const v = fbm(13, x, 0, { octaves });
        sum += Math.abs(v - prev);
        prev = v;
      }
      return sum;
    };
    expect(detail(5)).toBeGreaterThan(detail(1));
  });

  it('fbm1 就是固定 y 的 fbm', () => {
    expect(fbm1(21, 3.7)).toBe(fbm(21, 3.7, 0.5));
  });
});
