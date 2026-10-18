/**
 * 设置（localStorage）。
 *
 * 坑的源头：为了保护自己不被脏数据搞崩，保存层会写成"逐字段重建"，
 * 于是新增字段忘了在这里加一行 → 用户改了、刷新后悄悄变回默认值（这类坑踩过 3 次）。
 * 对策：
 * ① 每个字段一行 + 注释；② 单测用反射断言「DEFAULTS 的每个 key 都被处理」；
 * ③ 未知字段原样保留，新旧版本不互相覆盖。
 */
import { clamp } from './util';

export interface Settings {
  ver: number;
  /** 主音量 0..1 */
  vol: number;
  /** 音效开关 */
  sfx: boolean;
  /** 长按连挖间隔（毫秒） */
  digHoldMs: number;
  /** 摇杆在左还是右 */
  joySide: 'left' | 'right';
  /** 画质：auto 会按帧率自动降档 */
  quality: 'auto' | 'high' | 'mid' | 'low';
  /** 显示帧率 */
  showFps: boolean;
  /** 触感反馈（支持时） */
  haptics: boolean;
  /** 上次使用的种子文本 */
  lastSeed: string;
  /** 最近一次导出时间（ISO），用于「提醒备份」 */
  lastExport: string;
}

export const SETTINGS_KEY = 'eartheno:settings';

export const DEFAULT_SETTINGS: Settings = {
  ver: 1,
  vol: 0.6,
  sfx: true,
  digHoldMs: 180,
  joySide: 'left',
  quality: 'auto',
  showFps: false,
  haptics: true,
  lastSeed: '',
  lastExport: '',
};

/** 只接受有限数字。JSON 里没有 NaN，但 localStorage 被手改 / 内存里被别处写脏都可能出现 */
function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** 必须在这里逐个登记 —— 加字段时同步加一行 */
export function normalizeSettings(raw: unknown): Settings {
  const o: Settings = { ...DEFAULT_SETTINGS };
  if (!raw || typeof raw !== 'object') return o;
  const r = raw as Record<string, unknown>;
  if (finite(r.ver)) o.ver = Math.floor(r.ver);
  if (finite(r.vol)) o.vol = clamp(r.vol, 0, 1);
  if (typeof r.sfx === 'boolean') o.sfx = r.sfx;
  if (finite(r.digHoldMs)) o.digHoldMs = clamp(Math.round(r.digHoldMs), 120, 400);
  if (r.joySide === 'left' || r.joySide === 'right') o.joySide = r.joySide;
  if (r.quality === 'auto' || r.quality === 'high' || r.quality === 'mid' || r.quality === 'low') o.quality = r.quality;
  if (typeof r.showFps === 'boolean') o.showFps = r.showFps;
  if (typeof r.haptics === 'boolean') o.haptics = r.haptics;
  if (typeof r.lastSeed === 'string' && r.lastSeed.length < 64) o.lastSeed = r.lastSeed;
  if (typeof r.lastExport === 'string') o.lastExport = r.lastExport;
  // 未知字段保留
  for (const k of Object.keys(r)) if (!(k in o)) (o as any)[k] = r[k];
  return o;
}

export function loadSettings(): Settings {
  try {
    const txt = localStorage.getItem(SETTINGS_KEY);
    if (!txt) return { ...DEFAULT_SETTINGS };
    return normalizeSettings(JSON.parse(txt));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* 隐私模式 / 配额满：设置丢了也不该让游戏崩 */
  }
}
