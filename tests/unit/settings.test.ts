import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  DEFAULT_SETTINGS,
  SETTINGS_KEY,
  normalizeSettings,
  loadSettings,
  saveSettings,
  type Settings,
} from '../../src/core/settings';

/** 极简 localStorage 替身（Node 环境没有） */
function mockStorage() {
  const map = new Map<string, string>();
  const store = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    get length() {
      return map.size;
    },
  };
  vi.stubGlobal('localStorage', store);
  return store as unknown as Storage;
}

describe('设置默认值', () => {
  it('默认值本身合法', () => {
    expect(DEFAULT_SETTINGS.ver).toBeGreaterThanOrEqual(1);
    expect(DEFAULT_SETTINGS.vol).toBeGreaterThanOrEqual(0);
    expect(DEFAULT_SETTINGS.vol).toBeLessThanOrEqual(1);
    expect(DEFAULT_SETTINGS.digHoldMs).toBeGreaterThanOrEqual(120);
    expect(DEFAULT_SETTINGS.digHoldMs).toBeLessThanOrEqual(400);
    expect(['left', 'right']).toContain(DEFAULT_SETTINGS.joySide);
    expect(['auto', 'high', 'mid', 'low']).toContain(DEFAULT_SETTINGS.quality);
  });

  it('normalizeSettings 处理了 DEFAULTS 里的每一个 key（漏登记 = 用户设置悄悄丢失）', () => {
    // 反射：把每个 key 都改成"明显不同于默认值"的合法值，看是否被保留
    const sample: Record<string, unknown> = {
      ver: 2,
      vol: 0.123,
      sfx: !DEFAULT_SETTINGS.sfx,
      digHoldMs: 333,
      joySide: 'right',
      quality: 'low',
      showFps: !DEFAULT_SETTINGS.showFps,
      haptics: !DEFAULT_SETTINGS.haptics,
      lastSeed: 'abc123',
      lastExport: '2024-01-01T00:00:00.000Z',
    };
    const keys = Object.keys(DEFAULT_SETTINGS);
    // 每个 key 都必须有样本值，否则这个测试就形同虚设
    expect(Object.keys(sample).sort()).toEqual(keys.slice().sort());

    const out = normalizeSettings(sample);
    for (const k of keys) {
      expect(out[k as keyof Settings], `字段 ${k} 没有被 normalizeSettings 处理`).toEqual(sample[k]);
    }
  });
});

describe('设置清洗', () => {
  it('null / 非对象 / 空对象 → 默认值', () => {
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings(42)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings('x')).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings({})).toEqual(DEFAULT_SETTINGS);
  });

  it('类型不对的字段回落到默认值（而不是把整份设置丢掉）', () => {
    const out = normalizeSettings({ vol: '老大声', sfx: 'yes', showFps: 1, joySide: 'up', quality: 'ultra' });
    expect(out.vol).toBe(DEFAULT_SETTINGS.vol);
    expect(out.sfx).toBe(DEFAULT_SETTINGS.sfx);
    expect(out.showFps).toBe(DEFAULT_SETTINGS.showFps);
    expect(out.joySide).toBe(DEFAULT_SETTINGS.joySide);
    expect(out.quality).toBe(DEFAULT_SETTINGS.quality);
  });

  it('数值字段被夹到合法区间', () => {
    expect(normalizeSettings({ vol: 5 }).vol).toBe(1);
    expect(normalizeSettings({ vol: -3 }).vol).toBe(0);
    expect(normalizeSettings({ digHoldMs: 10 }).digHoldMs).toBe(120);
    expect(normalizeSettings({ digHoldMs: 9999 }).digHoldMs).toBe(400);
    expect(normalizeSettings({ digHoldMs: 200.7 }).digHoldMs).toBe(201); // 取整
  });

  it('lastSeed 过长时丢弃（防止脏数据灌爆 localStorage）', () => {
    expect(normalizeSettings({ lastSeed: 'a'.repeat(200) }).lastSeed).toBe('');
    expect(normalizeSettings({ lastSeed: 'a'.repeat(63) }).lastSeed).toHaveLength(63);
  });

  it('未知字段原样保留（新旧版本互不覆盖）', () => {
    const out = normalizeSettings({ futureThing: { a: 1 }, vol: 0.5 }) as Settings & { futureThing?: unknown };
    expect(out.futureThing).toEqual({ a: 1 });
    expect(out.vol).toBe(0.5);
  });

  it('NaN / Infinity 这类数字不算合法数字以外的情况：夹取后仍有限', () => {
    const out = normalizeSettings({ vol: NaN });
    expect(Number.isFinite(out.vol)).toBe(true);
    expect(out.vol).toBeGreaterThanOrEqual(0);
    expect(out.vol).toBeLessThanOrEqual(1);
  });
});

describe('读写 localStorage', () => {
  beforeEach(() => mockStorage());

  it('没存过时返回默认值', () => {
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('存了能读回来', () => {
    const s: Settings = { ...DEFAULT_SETTINGS, vol: 0.25, quality: 'low', joySide: 'right', digHoldMs: 250 };
    saveSettings(s);
    expect(loadSettings()).toEqual(s);
  });

  it('存的是 JSON，且用了约定的 key', () => {
    saveSettings({ ...DEFAULT_SETTINGS, vol: 0.9 });
    const raw = localStorage.getItem(SETTINGS_KEY);
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!).vol).toBe(0.9);
  });

  it('存的 JSON 坏了 → 回落默认值，不崩', () => {
    localStorage.setItem(SETTINGS_KEY, '{ 这不是 json');
    expect(() => loadSettings()).not.toThrow();
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('localStorage 写入抛错（隐私模式/配额满）时静默失败', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    });
    expect(() => saveSettings(DEFAULT_SETTINGS)).not.toThrow();
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });
});
