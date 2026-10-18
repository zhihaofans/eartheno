import { expect, test } from '@playwright/test';
import { openGame, resetStorage } from './helpers';

/**
 * 地下光照的回归用例。
 *
 * 这块画面踩过两个 bug，都是"看一眼就觉得整个世界坏了"的级别：
 *  ① 地表被误压暗 —— 阈值写死成绝对 y 值（70），而平地地表在 y≈77，
 *     结果大白天的地表蒙着一层 0.2 的灰，像加了滤镜。
 *  ② 地下全黑 —— 光圈圆心按错误的坐标换算画到了屏幕外（py 算成 -1956），
 *     暗层一点都擦不掉，下半屏是死黑。
 * 这两条用像素比对不好断言（抗锯齿/字体渲染跨机器不稳定），
 * 所以断言"可解释的量"：压暗强度、光圈圆心是否落在画布内。
 */
test.describe('地下光照', () => {
  test.beforeEach(async ({ page }) => {
    await resetStorage(page);
  });

  test('站在地表时完全不压暗（白天不该有滤镜）', async ({ page }) => {
    await openGame(page);
    await page.waitForTimeout(400);
    const d = await page.evaluate(() => window.__eartheno.darkness()!);
    expect(d).not.toBeNull();
    expect(d.visible).toBe(true);
    // 地表在海平面之上，压暗强度必须是 0
    expect(d.amount).toBe(0);
  });

  test('挖到地下深处会压暗，且光圈圆心落在画布内', async ({ page }) => {
    await openGame(page);
    const y0 = await page.evaluate(() => window.__eartheno.player()!.y);

    // 往下挖一条竖井再站到井底：直接用世界接口改地形，比真的挖快得多。
    //
    // 深度按**绝对值**取不少于 0x8c（140）：地表高度是随机的（实测起始 y 在 66~81 之间跳），
    // 按"相对 y0 + 34"算会时深时浅，浅的那几次压暗强度到不了阈值 —— 表现为偶发失败。
    // 落地后 body.y = 地板格 + 0.999，所以地板格放在 bottom+2，
    // 保证 141 这个位置有地板、且上方 3 格是空气。
    await page.evaluate((y: number) => {
      const api = window.__eartheno;
      const s = api.scene();
      const p = api.player()!;
      const tx = Math.floor(p.x);
      const bottom = Math.max(Math.round(y) + 40, 145);
      for (let ty = Math.round(y); ty <= bottom + 2; ty++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (s.world.getBlock(tx + dx, ty) !== 15) s.world.setBlock(tx + dx, ty, 0);
        }
      }
      // 井底铺两层石头站住（单层在低帧率下可能被下落速度隧穿）
      for (let dx = -1; dx <= 1; dx++) {
        s.world.setBlock(tx + dx, bottom + 1, 3);
        s.world.setBlock(tx + dx, bottom + 2, 3);
      }
      api.teleport(tx + 0.5, bottom + 1);
    }, y0);

    // 等 darknessAmount 稳定：它只取决于 body.y，落地即不动，是这里唯一可靠的信号。
    // 不用 onGround —— 落地瞬间的贴地校正会让它反复横跳几帧；
    // 也不再用 waitForTimeout(600/300)，整轮跑满时那个值根本不够。
    await page.waitForFunction(() => (window.__eartheno.darkness()?.amount ?? 0) > 0.4, null, { timeout: 8000 });

    const d = await page.evaluate(() => window.__eartheno.darkness()!);
    // 深处必须明显变暗（最多 0.86）
    expect(d.amount).toBeGreaterThan(0.4);

    // 光圈圆心必须在画布内 —— 这条直接拦住"py 算成负数导致全黑"那类 bug
    expect(d.center.x).toBeGreaterThan(0);
    expect(d.center.x).toBeLessThan(d.canvas.w);
    expect(d.center.y).toBeGreaterThan(0);
    expect(d.center.y).toBeLessThan(d.canvas.h);
  });

  test('低画质会关掉暗层（换帧率）', async ({ page }) => {
    await openGame(page);
    await page.evaluate(() => {
      window.__eartheno.settings().quality = 'low';
      window.__eartheno.scene().applySettingsQuality();
    });
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => window.__eartheno.darkness()!.visible)).toBe(false);

    await page.evaluate(() => {
      window.__eartheno.settings().quality = 'high';
      window.__eartheno.scene().applySettingsQuality();
    });
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => window.__eartheno.darkness()!.visible)).toBe(true);
  });
});
