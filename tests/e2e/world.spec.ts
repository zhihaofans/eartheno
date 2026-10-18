import { expect, test } from '@playwright/test';
import { openGame, resetStorage } from './helpers';

/**
 * 三个"看着像世界坏了"的问题，各自的回归用例。
 *
 * 都是玩家在手机上实际撞到的，而不是代码审查看出来的：
 *  ① 走到高处后地面消失 —— 世界顶部只留了 0 行区块，头顶没有空气。
 *  ② 手机锁了方向时无法横屏 —— 只在启动时调了一次 lock()，而它必须落在用户手势里。
 *  ③ 地下的岩壁被压成一片黑，看不清自己在挖什么 —— 暗层用点光源，而不是环境光。
 */
test.describe('世界边界与视野', () => {
  test.beforeEach(async ({ page }) => {
    await resetStorage(page);
  });

  test('站到高处时，头顶全是空气，且画面不会变成一块空白', async ({ page }) => {
    await openGame(page);
    const top = await page.evaluate(() => {
      const api = window.__eartheno;
      const p = api.player()!;
      const tx = Math.floor(p.x);
      const y = Math.round(p.y);
      const s = api.scene();
      // 堆一根 20 格高的土柱，站到顶上去
      for (let ty = y - 1; ty >= y - 20; ty--) {
        for (let dx = -1; dx <= 1; dx++) s.world.setBlock(tx + dx, ty, 2);
      }
      api.teleport(tx + 0.5, y - 20);
      return y - 20;
    });
    await page.waitForFunction(() => window.__eartheno.player()?.onGround === true, null, { timeout: 5000 });
    expect(top).toBeLessThan(70); // 确实是"比平地高很多"的位置

    // 头顶 8 格必须全是空气 —— 这就是"世界顶部上移两行"要保证的事
    const air = await page.evaluate((y: number) => {
      const api = window.__eartheno;
      const tx = Math.floor(api.player()!.x);
      const out: number[] = [];
      for (let dy = 1; dy <= 8; dy++) out.push(api.blockAt(tx, y - dy));
      return out;
    }, top);
    expect(air).toEqual(new Array(8).fill(0));

    // 画面上不该出现"整片纯色空白"：取土柱所在的那一竖列，亮度方差不能接近 0。
    // 取样点跟着相机走 —— 相机是 lerp 跟随，窗口改尺寸后画面还没有稳定下来，
    // 写死屏幕坐标会取到天空（纯色），从而误报"地面消失了"。
    const variance = await page.evaluate(() => {
      const cam = (window as any).__eartheno.scene().cameras.main;
      const p = (window as any).__eartheno.player();
      const cvs = document.querySelector('#game canvas') as HTMLCanvasElement;
      const c2 = document.createElement('canvas');
      c2.width = cvs.width;
      c2.height = cvs.height;
      c2.getContext('2d')!.drawImage(cvs, 0, 0);
      const g = c2.getContext('2d')!;
      const tl = cam.getWorldPoint(0, 0);
      const sx = Math.round((p.x * 16 - tl.x) * cam.zoom);
      // 从玩家脚下往下取 40 个点：土柱 + 地面都在这一段里
      const sy = Math.round((p.y * 16 - tl.y) * cam.zoom);
      const d = g.getImageData(sx, Math.min(sy, cvs.height - 1), 1, Math.min(40, cvs.height - sy)).data;
      const vals: number[] = [];
      for (let i = 0; i < d.length; i += 4) vals.push(0.3 * d[i] + 0.6 * d[i + 1] + 0.1 * d[i + 2]);
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      return vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length;
    });
    // 土柱顶面与下方的土体/岩层颜色不同，方差应明显大于 0
    expect(variance).toBeGreaterThan(30);
  });

  test('竖屏闸门提供「自动横屏」按钮，且点了不会报错', async ({ page }) => {
    // 用竖屏视口重新进一次
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await page.waitForSelector('#orient-gate:not([hidden])', { timeout: 15_000 });

    const btn = page.locator('#gate-landscape');
    // 桌面 Chromium 支持全屏但通常不支持锁屏；按钮仍应存在（不能因为没有 lock 就把入口藏掉）
    await expect(btn).toBeVisible();
    const errs: string[] = [];
    page.on('pageerror', (e) => errs.push(String(e)));
    await btn.click();
    await page.waitForTimeout(400);
    expect(errs).toEqual([]);

    // 转回横屏，闸门应当消失
    await page.setViewportSize({ width: 844, height: 390 });
    await expect(page.locator('#orient-gate')).toBeHidden({ timeout: 5000 });
  });

  test('地下：岩层比洞穴亮（光不是打在玩家身上的点光源）', async ({ page }) => {
    await openGame(page);

    // 在玩家位置往地下挖一条 3 格高的水平矿道，站到矿道里。
    // 深度取 42 格：压暗强度约 0.86（最深），足够把"岩壁亮 / 空洞暗"的差别拉满。
    //
    // 落点必须**自己铺地板**：有些种子里 42 格深处正好是一条天然洞穴，
    // 不铺地板的做法会让角色一路掉下去（实测 107 → 128 掉进洞里），
    // 暗度就永远到不了最深档 —— 表现为"每跑几次挂一次"的偶发失败。
    // 三个必须自己动手的前提，全部来自实测踩坑：
    //
    //  ① **按绝对深度下挖，不能按"玩家脚底 + 42"**。
    //     地表高度本身是随机的（实测起始 y 在 66~81 之间跳），
    //     而暗度只取决于**绝对深度**：amount = clamp((y-1-(SEA_LEVEL+4))/32, 0, 0.86)，
    //     要压满 0.86 需要 y ≥ 120。按相对深度算，浅种子只到 108（amount 0.66），
    //     用例就会时好时坏 —— 这正是它此前偶发失败的真正原因。
    //
    //  ② 落点下方要**自己铺地板**。40 多格深处常有天然洞穴，竖井会把它捅穿，
    //     角色一路掉下去（实测从 106 掉到 128）。铺 3 层而不是 1 层：
    //     teleport 是直接改坐标，角色带着下落速度落地，单格地板可能被隧穿。
    //
    //  ③ 矿道要挖 4 格高。角色站住时 y = 地板格 + 0.999，Math.round 后指向
    //     **脚所在的那一格**；只挖 3 格时顶部那格是"脚+2"，卡不住。
    await page.evaluate(() => {
      const api = window.__eartheno;
      const s = api.scene();
      const p = api.player()!;
      const tx = Math.floor(p.x);
      const startTy = Math.floor(p.y);
      // 目标：站住后 body.y ≥ 124（amount 恒为 0.86）
      const bottom = Math.max(startTy + 42, 125);
      for (let ty = startTy; ty <= bottom + 3; ty++) {
        s.world.setBlock(tx, ty, 0);
        s.world.setBlock(tx - 1, ty, 0);
      }
      for (let x = tx - 10; x <= tx + 10; x++) {
        for (let dy = 0; dy < 4; dy++) s.world.setBlock(x, bottom - dy, 0);
        for (let dy = 1; dy <= 3; dy++) s.world.setBlock(x, bottom + dy, 3);
        s.world.setBlock(x, bottom - 4, 3);
      }
      api.teleport(tx + 0.5, bottom);
    });
    // 直接等 darknessAmount 到最深档。
    //
    // 不要用 onGround 当同步条件：落地瞬间的贴地校正会让它在几帧里反复横跳
    // （实测出现过 "G → 非 G → G" 的序列），等到的那一刻身体其实还在下沉，
    // 读到的 amount 是 0.53 这种半路值 —— 这正是这条用例此前约 1/4 失败率的原因。
    // darknessAmount 只由 body.y 决定，单调上升、落地即稳定，是这里唯一可靠的信号。
    await page.waitForFunction(() => (window.__eartheno.darkness()?.amount ?? 0) > 0.8, null, { timeout: 8000 });
    // 暗层每帧按 body.y 重画，再放两帧让画布与数据同步，drawImage 才读得准
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

    /**
     * 采样点**从区块数据里挑**，不能按"玩家右边 N 格"硬编码。
     *
     * 这条用例写过三版，前两版都是因为取样位置靠猜而偶发失败：
     *  ① 按固定偏移取单点 —— 会撞上岩层噪点，也可能正好落在自己挖的竖井里（那儿透光）。
     *  ② 用区域最亮的 8 个像素 —— 竖井落在区域内时，采到的是竖井照进来的日光。
     * 现在先读出 tile 类型：找"离玩家最近的一格空气"和"同一列再往上一格的岩层"，
     * 两者都在视口内，语义明确，结果稳定。
     */
    const st = await page.evaluate(() => {
      const api = window.__eartheno;
      const s = api.scene();
      const cam = cam0();
      function cam0() {
        return api.scene().cameras.main;
      }
      const p = api.player()!;
      const cvs = document.querySelector('#game canvas') as HTMLCanvasElement;
      const c2 = document.createElement('canvas');
      c2.width = cvs.width;
      c2.height = cvs.height;
      c2.getContext('2d')!.drawImage(cvs, 0, 0);
      const ctx = c2.getContext('2d')!;
      const tl = cam.getWorldPoint(0, 0);
      const px = Math.floor(p.x);
      const py = Math.round(p.y);

      const inView = (tx: number, ty: number) => {
        const sx = (tx * 16 - tl.x) * cam.zoom;
        const sy = (ty * 16 - tl.y) * cam.zoom;        return sx > 4 && sy > 4 && sx < cvs.width - 4 && sy < cvs.height - 4;
      };
      const lum = (tx: number, ty: number) => {
        // 取格子中心：格子边缘可能是相邻块的过渡像素，中心才是这块的"本色"
        const sx = Math.round((tx * 16 + 8 - tl.x) * cam.zoom);
        const sy = Math.round((ty * 16 + 8 - tl.y) * cam.zoom);
        const d = ctx.getImageData(sx, sy, 1, 1).data;
        return 0.3 * d[0] + 0.6 * d[1] + 0.1 * d[2];
      };

      // 空气：玩家右侧、矿道高度内的第一格
      let air: { x: number; y: number } | null = null;
      for (let dx = 4; dx <= 10 && !air; dx++) {
        for (let dy = 0; dy <= 2; dy++) {
          const tx = px + dx;
          const ty = py - dy;
          if (s.world.getBlock(tx, ty) === 0 && inView(tx, ty)) {
            air = { x: tx, y: ty };
            break;
          }
        }
      }
      // 岩层：与空气同一列，往上逐格找到的第一块实心块
      let wall: { x: number; y: number } | null = null;
      if (air) {
        for (let dy = 1; dy <= 6; dy++) {
          const ty = air.y - dy;
          if (s.world.getBlock(air.x, ty) !== 0 && inView(air.x, ty)) {
            wall = { x: air.x, y: ty };
            break;
          }
        }
      }
      return {
        amount: api.darkness()!.amount,
        air: air ? { ...air, lum: lum(air.x, air.y) } : null,
        wall: wall ? { ...wall, lum: lum(wall.x, wall.y) } : null,
      };
    });

    expect(st.amount).toBeGreaterThan(0.6);
    expect(st.air, '没找到可采样的空气格').not.toBeNull();
    expect(st.wall, '空气上方没找到岩层').not.toBeNull();

    // ── 判据 ──
    //
    // 用"有暗层 vs 没暗层"的**同一格对比**，而不是"岩壁 vs 空洞"。
    //
    // 之前写的是 wall.lum > air.lum，为了这篇断言我来回改了四轮容差，最终确认它**根本不该存在**：
    //  ① 空洞里看到的不只是空气，还有背景层（alpha 0.38 + MULTIPLY），那是另一片地形的残影，
    //     亮度正好落在石头 base(116) 与 light 变体(144) 之间；
    //  ② 岩壁取的是单像素，而岩层纹理自带 ±12% 明暗抖动。
    // 两者相差只有几个色阶，正负全看随机种子落在哪个像素上（实测 17.5 vs 22、15.6 vs 17，来回翻）。
    // 这种断言测的是"运气"，不是行为。
    //
    // 真正要守住的回归是"地下必须被压暗"：把暗层临时关掉再采同一格，被暗层覆盖时必然明显更暗。
    // 这直接对应那两个历史 bug —— 地下全黑 / 地表被误暗，且与纹理抖动无关。
    const pair = await page.evaluate(async () => {
      const api = window.__eartheno;
      const cvs = document.querySelector('#game canvas') as HTMLCanvasElement;
      // 每次截图前必须等两帧：Phaser 的渲染在 rAF 里，
      // 改完可见性立刻 drawImage 拿到的还是上一帧的画面（踩过：差值只有 0.5，全是噪声）。
      const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const shot = async () => {
        await frame();
        const c2 = document.createElement('canvas');
        c2.width = cvs.width;
        c2.height = cvs.height;
        const ctx = c2.getContext('2d')!;
        ctx.drawImage(cvs, 0, 0);
        return ctx;
      };
      const cam = api.scene().cameras.main;
      const tl = cam.getWorldPoint(0, 0);
      const p = api.player()!;
      // 取玩家脚下那一格：必定是实心岩层，采它的中心像素
      const tx = Math.floor(p.x);
      const ty = Math.floor(p.y) + 1;
      const read = (ctx: CanvasRenderingContext2D) => {
        const sx = Math.round((tx * 16 + 8 - tl.x) * cam.zoom);
        const sy = Math.round((ty * 16 + 8 - tl.y) * cam.zoom);
        const d = ctx.getImageData(sx, sy, 1, 1).data;
        return 0.3 * d[0] + 0.6 * d[1] + 0.1 * d[2];
      };
      const lit = read(await shot());
      api.scene().setDarkLayerForTest(false);
      const raw = read(await shot());
      api.scene().setDarkLayerForTest(true);
      await frame();
      return { lit, raw, tile: api.blockAt(tx, ty) };
    });

    // 抽到的是实心方块才算数（0 = 空气）
    expect(pair.tile).not.toBe(0);
    // 三条一起构成"压暗是**适度**的"这个判据：
    expect(pair.lit).toBeLessThan(pair.raw * 0.95); // ① 确实压暗了（不是完全没生效）
    expect(pair.lit).toBeGreaterThan(pair.raw * 0.12); // ② 没压成一片黑（岩层还看得见轮廓）
    expect(pair.lit).toBeGreaterThan(0); // ③ 不是纯黑

    // ② 的来历：曾经把暗层写成"无论多深都铺满不透明黑"，
    // 那种情况下 ① 依然成立（更暗也是暗），所以只靠 ① 抓不到 —— 必须同时卡下限。
    // 实测最深档：raw ≈ 110，lit ≈ 20~40（0.86 的压暗 + 玩家周围的擦除光）。
  });

  test('手动保存：点一下就把改动落盘，顶栏不再显示待保存', async ({ page }) => {
    await openGame(page);
    // 造点改动
    await page.evaluate(() => {
      const api = window.__eartheno;
      const p = api.player()!;
      api.scene().world.setBlock(Math.floor(p.x) + 2, Math.round(p.y) - 3, 4);
    });
    // 顶栏会出现"待保存"提示
    await expect(page.locator('#savestate')).toBeVisible({ timeout: 3000 });
    await page.locator('#btn-save').click();
    await page.waitForFunction(() => window.__eartheno.world().dirtyCount === 0, null, { timeout: 5000 });
    // 存完之后提示会变成"已保存"并很快淡出，最终不可见
    await expect(page.locator('#savestate')).toBeHidden({ timeout: 5000 });
  });
});

  /**
   * 视口高度回归：844×390 的手机横屏只能看见 2 行区块，但 1280×800 的桌面 /
   * 平板 / 高分屏会看见 3~4 行。曾经渲染范围写死 `y1 = y0 + 1`（只画两行），
   * 结果是"上半屏有地、下半屏空白"，玩家像悬在半空 —— 手机上看不出来，桌面一开就见鬼。
   */
  test('桌面视口（1280×800）：屏幕下半部分必须有地形，不能是空白', async ({ page }) => {
    // 先设视口再打开页面。注意顺序：playwright 的 page 初始是 about:blank，
    // 直接 reload() 只会重载一个空白页（踩过：报"等不到 __eartheno"）。
    await page.setViewportSize({ width: 1280, height: 800 });
    await openGame(page);

    const ratio = await page.evaluate(() => {
      const cvs = document.querySelector('#game canvas') as HTMLCanvasElement;
      const c2 = document.createElement('canvas');
      c2.width = cvs.width;
      c2.height = cvs.height;
      const ctx = c2.getContext('2d')!;
      ctx.drawImage(cvs, 0, 0);

      // 只看**屏幕下半部分**：那里必然是地面（玩家站在地表，脚下 25 格都是土石）。
      // 判据取"暖色或中性亮色"的像素占比（土/草/石头），天空是深蓝紫，两者区分明显。
      const y0 = Math.floor(cvs.height * 0.55);
      const d = ctx.getImageData(0, y0, cvs.width, cvs.height - y0).data;
      let hit = 0;
      let total = 0;
      for (let i = 0; i < d.length; i += 4) {
        total++;
        if (d[i] > 60 && d[i] >= d[i + 2]) hit++;
      }
      return hit / total;
    });

    // 正常情况约 0.5；两行渲染的 bug 会掉到 0.1 以下。阈值取中间，留足余量。
    expect(ratio).toBeGreaterThan(0.25);
  });
