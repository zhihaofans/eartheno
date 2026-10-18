import { expect, test } from '@playwright/test';
import { openGame, resetStorage } from './helpers';

/** PWA / 离线 / 适配 */
test.describe('PWA 与适配', () => {
  test.beforeEach(async ({ page }) => {
    await resetStorage(page);
  });

  test('Service Worker 注册成功并接管页面', async ({ page }) => {
    await openGame(page);
    await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 20_000 });

    const info = await page.evaluate(async () => {
      const regs = await navigator.serviceWorker.getRegistrations();
      const keys = await caches.keys();
      return { regs: regs.length, keys };
    });
    expect(info.regs).toBeGreaterThan(0);
    // 缓存名带构建号：eartheno-<build>
    expect(info.keys.some((k) => k.startsWith('eartheno-'))).toBe(true);
  });

  test('预缓存里包含首页、样式、脚本与 manifest', async ({ page }) => {
    await openGame(page);
    await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 20_000 });

    const cached = await page.evaluate(async () => {
      const key = (await caches.keys()).find((k) => k.startsWith('eartheno-'))!;
      const cache = await caches.open(key);
      return (await cache.keys()).map((r) => new URL(r.url).pathname);
    });
    expect(cached.some((p) => p.endsWith('index.html'))).toBe(true);
    expect(cached.some((p) => p.includes('/assets/') && p.endsWith('.js'))).toBe(true);
    expect(cached.some((p) => p.includes('/assets/') && p.endsWith('.css'))).toBe(true);
    expect(cached.some((p) => p.endsWith('manifest.webmanifest'))).toBe(true);
  });

  test('断网后刷新仍能进游戏（离线可玩）', async ({ page, context }) => {
    await openGame(page);
    await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 20_000 });
    // 等预缓存装完
    await page.waitForTimeout(1200);

    await context.setOffline(true);
    await page.reload();
    await expect(page.locator('#ui')).toBeVisible({ timeout: 20_000 });
    const p = await page.evaluate(() => (window as any).__eartheno?.player?.() ?? null);
    expect(p).not.toBeNull();
    expect(p.onGround).toBe(true);
    await context.setOffline(false);
  });

  test('竖屏时显示"请横屏"闸门，转回横屏消失', async ({ page }) => {
    await openGame(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('#orient-gate')).toBeVisible();

    await page.setViewportSize({ width: 844, height: 390 });
    await expect(page.locator('#orient-gate')).toBeHidden();
  });

  test('窄屏（320 高）下控件不溢出视口', async ({ page }) => {
    await openGame(page);
    await page.setViewportSize({ width: 640, height: 320 });
    await page.waitForTimeout(400);

    const overflow = await page.evaluate(() => {
      const sel = ['#joystick', '#btn-jump', '#btn-dig', '#btn-place', '#hotbar'];
      const bad: string[] = [];
      for (const s of sel) {
        const el = document.querySelector(s) as HTMLElement | null;
        if (!el) continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0) continue;
        if (r.left < -1 || r.top < -1 || r.right > innerWidth + 1 || r.bottom > innerHeight + 1) {
          bad.push(`${s} ${JSON.stringify({ l: r.left, t: r.top, r: r.right, b: r.bottom })}`);
        }
      }
      return bad;
    });
    expect(overflow).toEqual([]);
  });

  test('manifest 可被解析且关键字段齐全', async ({ page }) => {
    const res = await page.goto('/manifest.webmanifest');
    const json = JSON.parse(await res!.text());
    expect(json.name).toContain('地髓');
    expect(json.orientation).toBe('landscape');
    expect(json.display).toBe('fullscreen');
    expect(json.start_url).toContain('./');
    const sizes = (json.icons as { sizes: string; purpose?: string }[]).map((i) => i.sizes);
    expect(sizes).toEqual(expect.arrayContaining(['192x192', '512x512']));
    expect((json.icons as { purpose?: string }[]).some((i) => i.purpose?.includes('maskable'))).toBe(true);
  });

  test('版本接口返回当前构建号（用于更新提示）', async ({ page }) => {
    const res = await page.goto('/version.json');
    const json = JSON.parse(await res!.text());
    expect(json.ver).toMatch(/^\d+\.\d+\.\d+$/);
    expect(json.build).toMatch(/^\d{8}-\d{4}-/);
  });
});
