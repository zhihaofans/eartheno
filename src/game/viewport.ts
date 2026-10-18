/**
 * 视口守卫：像素游戏在 iPhone 上最大的坑。
 *
 * 现象：首帧之后浏览器才把 visualViewport / dpr / 横竖屏「定下来」，
 * 若 Phaser 在启动那一刻就按初始尺寸建画布 → 黑边、画面被拉伸、触摸坐标整体偏移。
 * 对策：只在尺寸连续稳定后再通知 resize，并且永远不信任「启动瞬间」的尺寸。
 */

export interface ViewportInfo {
  w: number;
  h: number;
  dpr: number;
  landscape: boolean;
}

export function readViewport(): ViewportInfo {
  const vv = window.visualViewport;
  const w = Math.round(vv?.width ?? window.innerWidth);
  const h = Math.round(vv?.height ?? window.innerHeight);
  return { w, h, dpr: window.devicePixelRatio || 1, landscape: w > h };
}

export function isPortrait(info: ViewportInfo = readViewport()): boolean {
  // 竖屏判定：宽高比 < 1。桌面窄窗口不算竖屏手机，给出提示即可。
  return info.h > info.w;
}

/**
 * 监听尺寸变化，连续两次读数稳定后才回调（150ms 防抖）。
 *
 * 踩过的坑：只依赖 resize / orientationchange 在真机上**极不可靠**——
 * 全屏切换、地址栏收起、Android 分屏、CDP 改视口这些场景都不一定派发事件，
 * 结果就是"转成竖屏了但闸门不出现"，用户看到画面被裁掉却不知道要转回去。
 * 所以额外挂了一个 400ms 的轮询兜底：只在读数真的变了才进防抖。
 * 轮询成本可忽略（两个整数比较），换来的是任何尺寸变化都不会漏。
 * @returns 取消订阅
 */
export function onStableViewport(cb: (v: ViewportInfo) => void): () => void {
  let timer = 0;
  let last = readViewport();
  let settled = last;
  const fire = () => {
    window.clearTimeout(timer);
    // 两次读数（间隔 150ms）一致才算稳定
    timer = window.setTimeout(() => {
      const now = readViewport();
      const stable = now.w === last.w && now.h === last.h;
      last = now;
      if (stable) {
        settled = now;
        cb(now);
      } else {
        fire(); // 还在变，继续等
      }
    }, 150);
  };
  const maybeFire = () => {
    const now = readViewport();
    if (now.w !== settled.w || now.h !== settled.h) fire();
  };
  last = readViewport();
  window.addEventListener('resize', fire);
  window.addEventListener('orientationchange', fire);
  window.visualViewport?.addEventListener('resize', fire);
  const poll = window.setInterval(maybeFire, 400);
  return () => {
    window.clearTimeout(timer);
    window.clearInterval(poll);
    window.removeEventListener('resize', fire);
    window.removeEventListener('orientationchange', fire);
    window.visualViewport?.removeEventListener('resize', fire);
  };
}

/** 全屏能力探测：iOS Safari 没有 requestFullscreen，就别显示一个按了没反应的按钮 */
export function canFullscreen(): boolean {
  const el = document.documentElement as any;
  return typeof el.requestFullscreen === 'function' || typeof el.webkitRequestFullscreen === 'function';
}

export function isIos(): boolean {
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && (navigator as any).maxTouchPoints > 1);
}

export function isStandalone(): boolean {
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    (navigator as any).standalone === true
  );
}

export async function requestFullscreen(): Promise<void> {
  const el = document.documentElement as any;
  try {
    if (el.requestFullscreen) await el.requestFullscreen({ navigationUI: 'hide' });
    else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
  } catch {
    /* 用户拒绝或浏览器不允许：静默失败，不影响游戏 */
  }
}

/** 触感反馈（Android Chrome 有，iOS 无） */
export function vibrate(ms = 8): void {
  try {
    navigator.vibrate?.(ms);
  } catch {
    /* ignore */
  }
}
