/**
 * PWA：注册 SW、更新提示、离线提示。
 *
 * 三条纪律（经验文档 §7）：
 * ① 首次接管不是"更新"，不打扰用户（注册前先记 hadController）。
 * ② 有更新只提示，不自动 reload —— 玩家可能正在挖，刷新会丢当前未落盘的改动。
 * ③ 冷启动就离线时 offline 事件不触发，必须启动时主动探一次。
 */

export interface PwaHooks {
  /** 版本号，来自 version.json（拿不到就是 '—'，页面照常启动） */
  getBuild: () => string;
  /** 提示条 */
  banner(msg: string, actionLabel?: string, onAction?: () => void, opts?: { sticky?: boolean; kind?: 'info' | 'off' }): void;
  hideBanner(kind?: 'info' | 'off'): void;
  /** 刷新前需要落盘 */
  beforeReload(): Promise<void>;
}

const BUILD_SW = '__BUILD__';

export function versionJsonUrl(): string {
  return new URL('version.json', document.baseURI).href;
}

export async function loadVersion(): Promise<{ ver: string; build: string; note?: string }> {
  try {
    const r = await fetch(versionJsonUrl(), { cache: 'no-store' });
    if (!r.ok) throw new Error(String(r.status));
    const j = await r.json();
    return { ver: String(j.ver ?? '—'), build: String(j.build ?? '—'), note: j.note };
  } catch {
    return { ver: '—', build: '—' };
  }
}

export async function initPwa(h: PwaHooks): Promise<void> {
  // ── 离线提示 ──
  const showOffline = () => h.banner('离线模式 · 进度仍保存在本机', undefined, undefined, { sticky: true, kind: 'off' });
  if (!navigator.onLine) showOffline();
  window.addEventListener('offline', showOffline);
  window.addEventListener('online', () => h.hideBanner('off'));

  // ── Service Worker ──
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol === 'file:') return; // file:// 不注册 SW，游戏照常可玩

  const hadController = !!navigator.serviceWorker.controller;
  let prompted = false;
  const promptReload = () => {
    if (prompted) return;
    prompted = true;
    h.banner('有新版本可用', '刷新', async () => {
      await h.beforeReload();
      location.reload();
    });
  };

  try {
    const reg = await navigator.serviceWorker.register(new URL('sw.js', document.baseURI), {
      scope: './',
      updateViaCache: 'none',
    });

    // 首次接管不提示；之后的 controllerchange 才是真更新
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController) return;
      promptReload();
    });

    reg.addEventListener('updatefound', () => {
      const sw = reg.installing;
      if (!sw) return;
      sw.addEventListener('statechange', () => {
        if (sw.state === 'installed' && navigator.serviceWorker.controller) promptReload();
      });
    });

    // SW 字节没变时（只在构建号变了），切前台比对 version.json 是唯一能发现的路
    const checkVersion = async () => {
      if (document.visibilityState !== 'visible') return;
      const v = await loadVersion();
      if (v.build && v.build !== '—' && h.getBuild() !== v.build) {
        // 同一会话只提示一次
        const key = 'eartheno:updatePrompted';
        if (sessionStorage.getItem(key) === v.build) return;
        sessionStorage.setItem(key, v.build);
        promptReload();
      }
    };
    document.addEventListener('visibilitychange', checkVersion);
    window.addEventListener('focus', checkVersion);
  } catch {
    /* 注册失败（隐私模式 / 不支持）：不影响游戏 */
  }
  void BUILD_SW;
}
