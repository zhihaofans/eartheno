import { describe, it, expect } from 'vitest';
import { hash32, mulberry32, rngAt, randomSeed, seedToText, seedFromText } from '../../src/core/rng';

describe('种子化随机', () => {
  it('hash32 对同一组坐标恒等，且落在 uint32 范围', () => {
    expect(hash32(1, 2, 3)).toBe(hash32(1, 2, 3));
    const h = hash32(12345, -678, 999);
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThanOrEqual(0xffffffff);
    expect(Number.isInteger(h)).toBe(true);
  });

  it('hash32 对坐标敏感：相邻坐标不应撞在一起', () => {
    const seen = new Set<number>();
    for (let x = 0; x < 200; x++) seen.add(hash32(7, x, 0));
    // 200 个不同坐标，至少 199 个不同的哈希（允许理论上的碰撞）
    expect(seen.size).toBeGreaterThanOrEqual(199);
  });

  it('mulberry32 序列可复现，且均匀落在 [0,1)', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const seqA = Array.from({ length: 16 }, a);
    const seqB = Array.from({ length: 16 }, b);
    expect(seqA).toEqual(seqB);
    for (const v of seqA) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('mulberry32 输出分布大致均匀（均值接近 0.5）', () => {
    const r = mulberry32(2024);
    let sum = 0;
    const n = 20000;
    for (let i = 0; i < n; i++) sum += r();
    const mean = sum / n;
    expect(Math.abs(mean - 0.5)).toBeLessThan(0.02);
  });

  it('rngAt 与调用顺序无关：两个坐标互不干扰', () => {
    // A：先抽 (1,1) 三次，再抽 (2,2)
    const a1 = rngAt(9, 1, 1);
    a1(); a1(); a1();
    const a2 = rngAt(9, 2, 2);
    const fromA = a2();
    // B：直接抽 (2,2)
    const b2 = rngAt(9, 2, 2);
    expect(b2()).toBe(fromA);
  });

  it('randomSeed 返回非零 uint32（多次调用不重样）', () => {
    const seeds = new Set<number>();
    for (let i = 0; i < 32; i++) {
      const s = randomSeed();
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(0xffffffff);
      seeds.add(s);
    }
    expect(seeds.size).toBeGreaterThan(28);
  });

  it('seedToText / seedFromText 能往返', () => {
    for (const s of [0, 1, 0xffffffff, 0x1a2b3c4d, 123456789]) {
      const text = seedToText(s);
      expect(text).toHaveLength(8);
      expect(text).toMatch(/^[0-9a-f]{8}$/);
      expect(seedFromText(text)).toBe(s >>> 0);
    }
  });

  it('seedFromText 支持任意文本（同一文本 → 同一种子）', () => {
    expect(seedFromText('地髓')).toBe(seedFromText('地髓'));
    expect(seedFromText('  Eartheno  ')).toBe(seedFromText('eartheno'));
    expect(seedFromText('地髓')).not.toBe(seedFromText('Eartheno'));
  });
});
