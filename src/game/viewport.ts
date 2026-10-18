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

/** 是否已经全屏（含 iOS 的 webkit 私有属性、以及"从桌面图标启动"的情况） */
export function isFullscreenLike(): boolean {
  const d = document as any;
  return !!(
    d.fullscreenElement ||
    d.webkitFullscreenElement ||
    d.webkitDisplayingFullscreen ||
    isStandalone()
  );
}

/**
 * 尝试「横屏」：能锁横屏就锁横屏；不能锁（桌面 / iOS）就全屏，把画面最大化。
 *
 * 三条必须写进注释的事实，都是踩出来的：
 * ① `orientation.lock()` 只在**全屏之后**才允许，而且必须在**用户手势的同一任务里**调用。
 *    所以顺序永远是 requestFullscreen().then(lock)，不能反过来。
 * ② 它同时要求 `<meta name="viewport">` 里没有 `orientation` 限制 —— 我们没写，是对的。
 * ③ 手机上开着「方向锁定」时，系统旋转锁优先，网页锁横屏**无效**。
 *    这种情况只能靠 requestFullscreen + 用户物理转机，或者干脆别管（横屏时软件转屏会生效）。
 *
 * 永不抛错：拿不到全屏锁就静默返回 false，游戏该怎么玩还怎么玩。
 */
export async function requestLandscape(): Promise<{ fullscreen: boolean; locked: boolean }> {
  let fullscreen = false;
  if (!isFullscreenLike()) {
    const el = document.documentElement as any;
    try {
      if (el.requestFullscreen) await el.requestFullscreen({ navigationUI: 'hide' });
      else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
      fullscreen = isFullscreenLike();
    } catch {
      /* 被拒绝（不是手势 / 策略不允许）：继续尝试锁屏，失败也无所谓 */
    }
  } else {
    fullscreen = true;
  }
  let locked = false;
  try {
    const so = screen.orientation as any;
    if (so?.lock) {
      await so.lock('landscape');
      locked = true;
    }
  } catch {
    /* 桌面浏览器、iOS、或系统开了方向锁定：锁不上很正常 */
  }
  return { fullscreen, locked };
}

/** 全屏能力探测：iOS Safari 没有 requestFullscreen，就别显示一个按了没反应的按钮 */
export function canFullscreen(): boolean {
  const el = document.documentElement as any;
  return typeof el.requestFullscreen === 'function' || typeof el.webkitRequestFullscreen === 'function';
}

/** 能否锁横屏（Android Chromium / 全屏 PWA 可以，iOS 与桌面不行） */
export function canLockOrientation(): boolean {
  return typeof (screen.orientation as any)?.lock === 'function';
}

/**
 * 当前是否"被锁定为横屏"。
 *
 * 用途只有一个：竖屏闸门要不要继续挡人。
 * 锁横屏成功后，手机即使物理竖着，视口也是横的（宽>高）—— 这种情况闸门天然就不显示；
 * 但有些机型 lock 成功后视口尺寸不变，只是把画面整体旋转，这时靠这个标志放行。
 * `screen.orientation.type` 只有在 lock 成功且设备物理方向不符时才会是 landscape-xxx，
 * 而 `screen.orientation.angle` 在部分浏览器里不可靠，所以两个都看。
 */
export function isLandscapeLocked(): boolean {
  try {
    return String((screen.orientation as any)?.type ?? '').startsWith('landscape');
  } catch {
    return false;
  }
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
  await requestLandscape();
}

/** 触感反馈（Android Chrome 有，iOS 无） */
export function vibrate(ms = 8): void {
  try {
    navigator.vibrate?.(ms);
  } catch {
    /* ignore */
  }
}
