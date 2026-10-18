import { expect, type Page } from '@playwright/test';

/** 页面里注入的调试接口（见 src/main.ts 的 exposeDebug） */
export interface EarthenoApi {
  version: { ver: string; build: string };
  meta(): any;
  world(): any;
  scene(): any;
  settings(): any;
  flush(): Promise<void>;
  openPanel(k: string): void;
  panel(): string;
  teleport(x: number, y: number): void;
  give(key: string, n?: number): void;
  blockAt(x: number, y: number): number;
  setInput(p: { moveX?: number; dig?: boolean; jump?: boolean; placePressed?: boolean }): void;
  player(): { x: number; y: number; onGround: boolean; facing: number } | null;
  aim(): { x: number; y: number } | null;
  count(key: string): number;
  held(): string | null;
  digProgress(): number;
  screenOf(tx: number, ty: number): { x: number; y: number } | null;
  darkness(): {
    amount: number;
    visible: boolean;
    /** 本帧暗层是否真的重绘过 */
    painted: boolean;
    /** 暗层累计重绘次数，用来等"画面已按最终位置画好" */
    pass: number;
    center: { x: number; y: number };
    canvas: { w: number; h: number };
  } | null;
  save(): Promise<void>;
  exportText(): Promise<string>;
  importText(text: string): Promise<{ ok: true; seed: number; chunks: number } | { ok: false; error: string }>;
  craft(id: string): { ok: true; out: string; n: number } | { ok: false; code: string };
  memoryOnly: boolean;
}

declare global {
  interface Window {
    __eartheno: EarthenoApi;
  }
}

/** 等到"场景建好并且玩家站在地上" —— 比等固定毫秒数稳 */
export async function waitPlayable(page: Page, timeout = 20_000) {
  await page.waitForFunction(() => !!(window as any).__eartheno?.scene?.(), null, { timeout });
  await page.waitForFunction(() => (window as any).__eartheno.player()?.onGround === true, null, { timeout });
  await expect(page.locator('#boot')).toBeHidden();
  await expect(page.locator('#ui')).toBeVisible();
}

/** 打开页面并进入可操作状态 */
export async function openGame(page: Page) {
  await page.goto('/');
  await waitPlayable(page);
}

/**
 * 换一条种子重开：模拟"用户点新世界"。
 * 走 IndexedDB 直接改 meta 再 reload —— 比点弹窗稳，也不受输入法/键盘影响。
 */
export async function useSeed(page: Page, seed: number) {
  await page.evaluate(async (s: number) => {
    await new Promise<void>((res) => {
      const req = indexedDB.open('eartheno');
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('meta', 'readwrite');
        const os = tx.objectStore('meta');
        const get = os.get('world'); // ← meta store 的 key 是 'world'，不是 'main'
        get.onsuccess = () => {
          const m = get.result;
          m.seed = s;
          m.player.x = 0;
          m.player.y = 80;
          os.put(m, 'world');
        };
        tx.oncomplete = () => {
          db.close();
          res();
        };
        tx.onerror = () => res();
      };
      req.onerror = () => res();
    });
  }, seed >>> 0);
  await page.reload();
  await waitPlayable(page);
}

/** 把玩家挪到某一列的地面上（跳过长途跋涉） */
export async function standOn(page: Page, tx: number) {
  await page.evaluate((x: number) => {
    const api = (window as any).__eartheno;
    const scene = api.scene();
    const startY = Math.floor(api.player().y) - 60;
    for (let ty = Math.max(1, startY); ty < startY + 200; ty++) {
      if (scene.world.isSolid(Math.floor(x), ty)) {
        api.teleport(Math.floor(x) + 0.5, ty);
        return;
      }
    }
  }, tx);
  await page.waitForFunction(() => (window as any).__eartheno.player()?.onGround === true, null, { timeout: 8000 });
}

/** 找到玩家脚下/身边一个"确定能挖"的方块坐标（含掉落物映射，木→木） */
export async function findDiggable(page: Page) {
  return page.evaluate(() => {
    const api = (window as any).__eartheno;
    const p = api.player();
    const fx = Math.floor(p.x);
    const feet = Math.round(p.y); // 脚底格线 = 站在地面上时所在的格
    // 优先挖脚边那格：不会挖穿地板掉下去，aimTile 也稳稳指向它
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [1, -1],
      [-1, -1],
    ]) {
      const tx = fx + dx;
      const ty = feet + dy;
      if (api.scene().world.isSolid(tx, ty)) return { tx, ty };
    }
    return null;
  });
}

/** 清空本地状态，得到干净的首次启动 */
export async function resetStorage(page: Page) {
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.evaluate(async () => {
    localStorage.clear();
    sessionStorage.clear();
    if (indexedDB.databases) {
      const dbs = await indexedDB.databases();
      await Promise.all(
        dbs.map(
          (d) =>
            new Promise<void>((res) => {
              if (!d.name) return res();
              const req = indexedDB.deleteDatabase(d.name);
              req.onsuccess = req.onerror = req.onblocked = () => res();
            }),
        ),
      );
    }
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
    const regs = await navigator.serviceWorker?.getRegistrations?.();
    await Promise.all((regs ?? []).map((r) => r.unregister()));
  });

  // 关键：等清除**真的生效**再返回。
  //
  // 踩过的坑：beforeEach 里 resetStorage 返回后紧接着就 page.goto('/manifest.webmanifest')，
  // 但此时上一个用例留下的 SW 可能还活着（unregister 是异步的，且已接管的页面在
  // 本次导航结束前仍然受它控制）。SW 的 stale-while-revalidate 会先把**缓存的旧响应**
  // 吐出来 —— 如果上一次构建用的是不同 base，旧 manifest 的 start_url 就不对，
  // 用例会以"manifest 字段不全"这种完全误导的理由失败。
  // 现在显式轮询到"没有注册、没有缓存"为止，最多等 3 秒。
  await page
    .waitForFunction(
      async () => {
        if ('caches' in window) {
          const keys = await caches.keys();
          if (keys.length) return false;
        }
        const regs = (await navigator.serviceWorker?.getRegistrations?.()) ?? [];
        return regs.length === 0;
      },
      null,
      { timeout: 3000 },
    )
    .catch(() => {
      /* 超时就让后面的用例自己暴露（不在这里吞掉真实问题） */
    });
}
