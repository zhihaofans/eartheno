import { expect, test } from '@playwright/test';
import { findDiggable, openGame, resetStorage } from './helpers';

/**
 * 核心循环冒烟：进得去 → 走得了 → 挖得到 → 放得下 → 长按能连挖。
 * 这一组挂了就说明"游戏不能玩"，其他都不用看。
 */
test.describe('核心循环', () => {
  test.beforeEach(async ({ page }) => {
    await resetStorage(page);
  });

  test('开局进入游戏，玩家站在地上，无 JS 报错', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await openGame(page);

    const p = await page.evaluate(() => window.__eartheno.player());
    expect(p).not.toBeNull();
    expect(p!.onGround).toBe(true);
    // 脚下（脚底格线所在的格）必须有地：约定 body.y 就是脚下那格的顶边
    const below = await page.evaluate(([x, y]) => window.__eartheno.scene().world.isSolid(x, y), [Math.floor(p!.x), Math.round(p!.y)] as const);
    expect(below).toBe(true);

    // 默认快捷栏第一格是夯土
    const meta = await page.evaluate(() => window.__eartheno.meta());
    expect(meta.inv.hotbar[0]).toBe('dirt');
    expect(errors).toEqual([]);
  });

  test('虚拟摇杆能推动角色，松手会停', async ({ page }) => {
    await openGame(page);
    const before = await page.evaluate(() => window.__eartheno.player()!);

    await page.evaluate(() => window.__eartheno.setInput({ moveX: 1 }));
    // 等"真的走出一格"，而不是等固定 700ms。
    // 固定时长在负载高时会误报：全量跑 / CI 冷启动时帧率不足，
    // 700ms 内角色可能还没走到 1 格 —— 那是测试脆弱，不是游戏坏了。
    await page
      .waitForFunction((x0) => window.__eartheno.player()!.x > x0 + 1, before.x, { timeout: 5000 })
      .catch(() => {}); // 超时留给下面的断言报具体数值，错误信息更有用
    const during = await page.evaluate(() => window.__eartheno.player()!);
    expect(during.x).toBeGreaterThan(before.x + 1);

    await page.evaluate(() => window.__eartheno.setInput({ moveX: 0 }));
    // 松手停下：判据用**速度归零**，不要用"两次采样位置一样"。
    // 位置判据有个经典的坑：waitForFunction 两次调用之间隔着一帧，
    // 上一次记下的 prev 和这一次的当前值始终差着一帧的位移，
    // 结果判据会在真/假之间抖，偶尔永远不成立。
    await page.waitForFunction(() => Math.abs(window.__eartheno.scene().body.vx) < 0.05, null, {
      timeout: 4000,
    });
    const after = await page.evaluate(() => window.__eartheno.player()!);
    expect(Math.abs(after.x - during.x)).toBeLessThan(0.5);
  });

  test('跳跃能离地并落回地面', async ({ page }) => {
    await openGame(page);
    const before = await page.evaluate(() => window.__eartheno.player()!);

    await page.evaluate(() => window.__eartheno.setInput({ jump: true }));
    await page.waitForTimeout(260);
    const peak = await page.evaluate(() => window.__eartheno.player()!);
    expect(peak.y).toBeLessThan(before.y - 1.2);

    await page.waitForFunction(() => (window as any).__eartheno.player()?.onGround === true, null, { timeout: 4000 });
  });

  test('长按挖掘：有进度条、能挖掉方块、掉落进背包', async ({ page }) => {
    await openGame(page);
    const target = await findDiggable(page);
    expect(target).not.toBeNull();
    const { tx, ty } = target!;
    const idBefore = await page.evaluate(([x, y]) => window.__eartheno.blockAt(x, y), [tx, ty] as const);
    expect(idBefore).not.toBe(0);

    // 站到目标格左边的空中，落到左边那格的地面 —— 此时 aimTile 正对目标格
    // （注意：从空地落到 target 自己那一格会被直接弹到目标顶上，所以锚点取左侧）
    await page.evaluate(([x, y]) => {
      const api = window.__eartheno;
      api.teleport(x - 1 + 0.5, y + 1);
      api.scene().body.facing = 1;
    }, [tx, ty] as const);
    await page.waitForFunction(() => (window as any).__eartheno.player()?.onGround === true, null, { timeout: 5000 });
    const aimNow = await page.evaluate(() => window.__eartheno.aim()!);
    expect(aimNow).toEqual({ x: tx, y: ty });

    const dirtBefore = await page.evaluate(() => window.__eartheno.count('dirt'));
    await page.evaluate(() => window.__eartheno.setInput({ dig: true }));
    // 长按 400ms 后应该已经有非零进度（证明是"持续累积"而不是单次判定）
    await page.waitForTimeout(400);
    const mid = await page.evaluate(() => window.__eartheno.digProgress());
    expect(mid).toBeGreaterThan(0);

    await page.waitForFunction(([x, y]) => window.__eartheno.blockAt(x, y) === 0, [tx, ty] as const, { timeout: 10_000 });
    await page.evaluate(() => window.__eartheno.setInput({ dig: false }));

    const dirtAfter = await page.evaluate(() => window.__eartheno.count('dirt'));
    expect(dirtAfter).toBeGreaterThan(dirtBefore);
  });

  test('放置方块：世界出现方块、背包扣一个', async ({ page }) => {
    await openGame(page);
    const aim = await page.evaluate(() => window.__eartheno.aim()!);
    // 确保目标是空气
    const isAir = await page.evaluate(([x, y]) => window.__eartheno.blockAt(x, y) === 0, [aim.x, aim.y] as const);

    await page.evaluate(() => {
      window.__eartheno.give('torch', 5);
      const inv = window.__eartheno.meta().inv;
      inv.hotbar[0] = 'torch';
      window.__eartheno.scene().activeSlot = 0;
    });
    const torchBefore = await page.evaluate(() => window.__eartheno.count('torch'));
    await page.evaluate(() => window.__eartheno.setInput({ placePressed: true }));
    await page.waitForTimeout(300);

    const placed = await page.evaluate(([x, y]) => window.__eartheno.blockAt(x, y), [aim.x, aim.y] as const);
    if (isAir) {
      expect(placed).not.toBe(0);
      expect(await page.evaluate(() => window.__eartheno.count('torch'))).toBe(torchBefore - 1);
    } else {
      // 目标不是空气 → 本来就不该放，库存不变
      expect(await page.evaluate(() => window.__eartheno.count('torch'))).toBe(torchBefore);
    }
  });

  test('跑过若干个 chunk 后仍站在地面上（不会掉出世界）', async ({ page }) => {
    await openGame(page);
    for (const x of [-40, -10, 20, 50]) {
      await page.evaluate((tx) => {
        const api = window.__eartheno;
        const scene = api.scene();
        const startY = Math.floor(api.player()!.y) - 60;
        for (let ty = Math.max(1, startY); ty < startY + 200; ty++) {
          if (scene.world.isSolid(Math.floor(tx), ty)) {
            api.teleport(Math.floor(tx) + 0.5, ty);
            return;
          }
        }
      }, x);
      await page.waitForFunction(() => (window as any).__eartheno.player()?.onGround === true, null, { timeout: 8000 });
      const p = await page.evaluate(() => window.__eartheno.player()!);
      expect(p.y).toBeGreaterThan(0);
      expect(p.y).toBeLessThan(158);
    }
  });
});
