/**
 * 种子化随机与哈希。
 *
 * 为什么自己写而不依赖 Math.random 或第三方库：
 * - 世界生成必须"同种子同结果"，跨设备、跨版本都要一致（存档只记录改动过的 chunk，
 *   未改动的 chunk 是读档时重新生成的 —— 生成器一变，老存档的地形就变了）。
 * - 单测要能断言固定种子的输出序列。
 */

/** 32 位整数混洗（murmur3 的 finalizer），用于把坐标压成一个种子 */
export function hash32(a: number, b: number, c = 0): number {
  let h = (a | 0) * 0x27d4eb2d;
  h = (h ^ (h >>> 15)) | 0;
  h = (h + (b | 0) * 0x165667b1) | 0;
  h = (h ^ (h >>> 13)) | 0;
  h = (h + (c | 0) * 0x9e3779b1) | 0;
  h = (h ^ (h >>> 16)) | 0;
  return h >>> 0;
}

/** mulberry32：8 行、质量足够、无浮点歧义 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 为某个坐标派生一个独立随机源：抽多少个、按什么顺序抽都不互相影响 */
export function rngAt(seed: number, a: number, b: number): () => number {
  return mulberry32(hash32(seed, a, b));
}

export function randomSeed(): number {
  const buf = new Uint32Array(1);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(buf);
  else buf[0] = Math.floor(Math.random() * 0xffffffff);
  return buf[0] >>> 0;
}

/** 种子展示用：8 位小写十六进制 */
export function seedToText(seed: number): string {
  return (seed >>> 0).toString(16).padStart(8, '0');
}

export function seedFromText(text: string): number {
  const t = text.trim().toLowerCase();
  if (/^[0-9a-f]{1,8}$/.test(t)) return parseInt(t, 16) >>> 0;
  // 任意字符串 → 哈希成种子
  let h = 2166136261;
  for (let i = 0; i < t.length; i++) {
    h ^= t.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
