#!/usr/bin/env node
/**
 * 生成 README 里的预览截图。
 *
 * 用法（需要先 `npm run build`，并让 preview 跑在 4319 端口）：
 *   npx vite preview --port 4319 --host 127.0.0.1 &
 *   node tools/shots.mjs
 *
 * 为什么单独写脚本而不是手工截图：
 *  ① 手工截图会过期 —— 上一次改完地下光照，README 里的图还是"同心环"版本。
 *  ② 需要"造场景"：地下那张必须真的挖一口竖井、站到井底，否则暗层根本不会触发。
 *  ③ 设备参数要固定（844×390 @2x、触屏、移动端 UA），否则排版会跟真机不一致。
 */
import { chromium } from 'playwright-core';

const BASE = process.env.SHOT_BASE || 'http://127.0.0.1:4319/';
const OUT = new URL("../screenshots/", import.meta.url).pathname;

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext({
  viewport: { width: 844, height: 390 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
});
const page = await ctx.newPage();
await page.goto(BASE);

/** 等场景建好且角色落地（场景建好之前 player() 会抛错，所以要 try） */
await page.waitForFunction(
  () => {
    try {
      return !!window.__eartheno?.scene?.() && window.__eartheno.player()?.onGround === true;
    } catch {
      return false;
    }
  },
  null,
  { timeout: 20000 },
);
await page.waitForTimeout(1600);

const shot = async (name) => {
  await page.screenshot({ path: `${OUT}${name}.png` });
  console.log(`  docs/${name}.png`);
};

// ① 地表：先给点材料，让快捷栏不是空的
await page.evaluate(() => {
  for (const [k, n] of [
    ['dirt', 24],
    ['cobble', 12],
    ['plank', 8],
  ]) {
    window.__eartheno.give(k, n);
  }
});
await page.waitForTimeout(500);
await shot('地表');

// ② 挖掘中：按住挖掘按钮，抓"进度 + 裂纹 + 按钮高亮"那一帧
const box = await page.locator('#btn-dig').boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.down();
await page.waitForTimeout(420);
await shot('挖掘中');
await page.mouse.up();
await page.waitForTimeout(200);

// ③ 地下：挖一口 7 宽竖井站到井底，暗层与光晕才会出现
await page.evaluate(() => {
  const api = window.__eartheno;
  const s = api.scene();
  const p = api.player();
  const tx = Math.floor(p.x);
  const top = Math.round(p.y);
  const bottom = top + 30;
  for (let ty = top; ty <= bottom; ty++) {
    for (let dx = -3; dx <= 3; dx++) {
      if (s.world.getBlock(tx + dx, ty) !== 15) s.world.setBlock(tx + dx, ty, 0);
    }
  }
  for (let dx = -3; dx <= 3; dx++) s.world.setBlock(tx + dx, bottom + 1, 3);
  api.teleport(tx + 0.5, bottom + 1);
});
await page.waitForTimeout(1800);
await shot('地下');

// ④ 合成面板
await page.evaluate(() => window.__eartheno.openPanel('craft'));
await page.waitForTimeout(400);
await shot('合成');
await page.evaluate(() => window.__eartheno.openPanel(''));

// ⑤ 竖屏闸门
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(900);
await shot('竖屏提示');

await browser.close();
console.log('完成');
