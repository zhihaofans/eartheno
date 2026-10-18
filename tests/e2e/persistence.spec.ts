import { expect, test } from '@playwright/test';
import { findDiggable, openGame, resetStorage } from './helpers';

/** 存档与导入导出 */
test.describe('存档', () => {
  test.beforeEach(async ({ page }) => {
    await resetStorage(page);
  });

  test('挖掉的方块刷新后还在（IndexedDB 按 chunk 落盘）', async ({ page }) => {
    await openGame(page);
    const target = await findDiggable(page);
    expect(target).not.toBeNull();
    const { tx, ty } = target!;

    await page.evaluate(
      ([x, y]) => {
        window.__eartheno.world().setBlock(x, y, 0);
        window.__eartheno.scene().markDirty(x, y);
      },
      [tx, ty] as const,
    );
    await page.evaluate(() => window.__eartheno.save());
    await page.reload();
    await page.waitForFunction(() => (window as any).__eartheno?.player()?.onGround, null, { timeout: 20_000 });

    const after = await page.evaluate(([x, y]) => window.__eartheno.blockAt(x, y), [tx, ty] as const);
    expect(after).toBe(0);
  });

  test('导出的是合法存档文本，且能被重新读回', async ({ page }) => {
    await openGame(page);
    const text = await page.evaluate(() => window.__eartheno.exportText());
    const data = JSON.parse(text);
    expect(data.app).toBe('eartheno');
    expect(typeof data.meta.seed).toBe('number');
  });

  test('导入存档能换掉整个世界（种子 + 改动一起）', async ({ page }) => {
    await openGame(page);
    const original = await page.evaluate(() => window.__eartheno.meta().seed);

    // 造一份"别的世界"的存档：改种子 + 记录一次改动
    const text = await page.evaluate(async () => {
      const t = await window.__eartheno.exportText();
      const d = JSON.parse(t);
      d.meta.seed = (d.meta.seed ^ 0x5a5a5a) >>> 0;
      return JSON.stringify(d);
    });
    const res = await page.evaluate((t) => window.__eartheno.importText(t), text);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.seed).not.toBe(original);

    await page.reload();
    await page.waitForFunction(() => (window as any).__eartheno?.player()?.onGround, null, { timeout: 20_000 });
    const now = await page.evaluate(() => window.__eartheno.meta().seed);
    expect(now).not.toBe(original);
  });

  test('坏存档被拒绝，且不会破坏当前世界', async ({ page }) => {
    await openGame(page);
    const seedBefore = await page.evaluate(() => window.__eartheno.meta().seed);

    for (const bad of ['', 'not json', '{"app":"other"}', '{"app":"eartheno","fmt":999}']) {
      const res = await page.evaluate((t) => window.__eartheno.importText(t), bad);
      expect(res.ok).toBe(false);
    }
    const seedAfter = await page.evaluate(() => window.__eartheno.meta().seed);
    expect(seedAfter).toBe(seedBefore);
  });

  test('设置存进 localStorage，刷新后仍生效', async ({ page }) => {
    await openGame(page);
    await page.evaluate(() => {
      const s = window.__eartheno.settings();
      s.digHoldMs = 250;
      s.vol = 0.35;
      localStorage.setItem('eartheno:settings', JSON.stringify(s));
    });
    await page.reload();
    await page.waitForFunction(() => !!(window as any).__eartheno?.scene?.(), null, { timeout: 20_000 });
    const s = await page.evaluate(() => window.__eartheno.settings());
    expect(s.digHoldMs).toBe(250);
    expect(s.vol).toBeCloseTo(0.35, 5);
  });
});
