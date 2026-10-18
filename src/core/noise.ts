/**
 * 2D 值噪声 + fBm。够用、可复现、无外部依赖。
 * 所有输出都保证落在 [0, 1)。
 */
import { hash32 } from './rng';

function lattice(seed: number, x: number, y: number): number {
  return hash32(seed, x, y) / 4294967296;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

/** 单层值噪声，带 wrap 周期（0 表示不 wrap）。周期用于生成可无缝平铺的视差背景。 */
export function valueNoise(seed: number, x: number, y: number, period = 0): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const w = (n: number, base: number) => (period > 0 ? ((n % period) + period) % period : n) + base;
  const x0 = w(xi, 0);
  const x1 = w(xi + 1, 0);
  const y0 = w(yi, 0);
  const y1 = w(yi + 1, 0);
  const n00 = lattice(seed, x0, y0);
  const n10 = lattice(seed, x1, y0);
  const n01 = lattice(seed, x0, y1);
  const n11 = lattice(seed, x1, y1);
  const u = smooth(xf);
  const v = smooth(yf);
  const a = n00 + (n10 - n00) * u;
  const b = n01 + (n11 - n01) * u;
  return a + (b - a) * v;
}

export interface FbmOptions {
  octaves?: number;
  lacunarity?: number;
  gain?: number;
  period?: number;
}

export function fbm(seed: number, x: number, y: number, opt: FbmOptions = {}): number {
  const octaves = opt.octaves ?? 4;
  const lac = opt.lacunarity ?? 2;
  const gain = opt.gain ?? 0.5;
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    const p = opt.period ? Math.max(1, Math.round(opt.period * freq)) : 0;
    sum += amp * valueNoise(seed + i * 1013, x * freq, y * freq, p);
    norm += amp;
    amp *= gain;
    freq *= lac;
  }
  return sum / norm;
}

/** 一维 fBm，地形高度用 */
export function fbm1(seed: number, x: number, opt: FbmOptions = {}): number {
  return fbm(seed, x, 0.5, opt);
}
