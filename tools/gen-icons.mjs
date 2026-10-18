#!/usr/bin/env node
/**
 * 生成 PWA 图标 + iOS 启动图 + SVG favicon。
 *
 * 为什么不用现成的图标库：整个项目 0 个图片资源 —— 图标也程序化画出来，
 * 和游戏里的方块纹理用同一套配色，视觉一致且仓库里不留二进制大文件。
 *
 * 输出（public/icons/）：
 *   icon-192.png / icon-512.png / icon-512-maskable.png / apple-180.png / favicon-32.png
 *   icon.svg（现代浏览器 & manifest 的 any 尺寸）
 *   shot-landscape.png（manifest screenshots，用于安装弹窗预览）
 *
 * 实现：直接手写最小 PNG 编码（zlib deflate + CRC32），不依赖 canvas 库。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
mkdirSync(OUT, { recursive: true });

// ── 调色板（与 src/art/blocks.ts 保持一致的地脉色系）────────
const PAL = {
  bg0: [16, 19, 26],
  bg1: [28, 34, 46],
  soil: [92, 64, 42],
  soilDark: [64, 43, 28],
  grass: [96, 168, 88],
  grassDark: [62, 122, 60],
  stone: [122, 126, 138],
  stoneDark: [86, 90, 102],
  glow: [126, 230, 214],
  glowDark: [62, 168, 158],
  ember: [232, 138, 82],
  ink: [10, 12, 16],
};

// ── 最小 PNG 编码 ────────────────────────────────────────
function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** rgba: Uint8Array(w*h*4) */
function encodePng(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── 画布工具 ─────────────────────────────────────────────
function canvas(size) {
  const px = new Uint8Array(size * size * 4);
  const put = (x, y, c, a = 255) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    px[i] = c[0];
    px[i + 1] = c[1];
    px[i + 2] = c[2];
    px[i + 3] = a;
  };
  const rect = (x, y, w, h, c) => {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) put(xx, yy, c);
  };
  /** 圆角矩形（半径按像素给） */
  const round = (x, y, w, h, r, c) => {
    for (let yy = y; yy < y + h; yy++) {
      for (let xx = x; xx < x + w; xx++) {
        const dx = Math.min(xx - x, x + w - 1 - xx);
        const dy = Math.min(yy - y, y + h - 1 - yy);
        if (dx < r && dy < r) {
          const ddx = r - dx;
          const ddy = r - dy;
          if (ddx * ddx + ddy * ddy > r * r) continue;
        }
        put(xx, yy, c);
      }
    }
  };
  return { px, put, rect, round, size };
}

/**
 * 图标构图：一块被撬开的地层，缝隙里透出青辉。
 * 纯几何绘制，缩小到 32px 也能认出是"方块 + 裂缝"。
 */
function drawIcon(size, { maskable = false, rounded = true } = {}) {
  const c = canvas(size);
  const u = size / 16; // 以 16 单位网格作图，和游戏 tile 感一致
  const r = (n) => Math.round(n * u);

  // 背景：径向渐变的深色（手动两段近似）
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - size / 2, y - size / 2) / (size * 0.72);
      const t = Math.min(1, d);
      const col = [
        Math.round(PAL.bg1[0] * (1 - t) + PAL.bg0[0] * t),
        Math.round(PAL.bg1[1] * (1 - t) + PAL.bg0[1] * t),
        Math.round(PAL.bg1[2] * (1 - t) + PAL.bg0[2] * t),
      ];
      c.put(x, y, col);
    }
  }
  if (rounded && !maskable) {
    // 圆角遮罩
    const rad = Math.round(size * 0.22);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = Math.min(x, size - 1 - x);
        const dy = Math.min(y, size - 1 - y);
        if (dx < rad && dy < rad) {
          const ddx = rad - dx;
          const ddy = rad - dy;
          if (ddx * ddx + ddy * ddy > rad * rad) {
            const i = (y * size + x) * 4;
            c.px[i + 3] = 0;
          }
        }
      }
    }
  }

  // maskable 要把内容收进安全区（直径 80%）
  const inset = maskable ? r(3.2) : r(2.2);
  const w = size - inset * 2;

  // 上方：天光（深色天空）
  c.round(inset, inset, w, Math.round(w * 0.24), Math.round(u * 0.5), PAL.bg1);
  // 天光里一点星
  c.rect(inset + Math.round(w * 0.72), inset + Math.round(w * 0.07), Math.max(1, Math.round(u * 0.5)), Math.max(1, Math.round(u * 0.5)), PAL.glowDark);

  // 地层（从 y0 往下）：草皮层 → 土层 → 岩层
  const x0 = inset;
  const y0 = inset + Math.round(w * 0.24);
  const totalH = w - (y0 - inset);
  const grassH = Math.round(totalH * 0.16);
  const dirtH = Math.round(totalH * 0.34);
  const rockH = totalH - grassH - dirtH;

  // 左半是土，右半剖面露岩 —— 做出"被挖开的切面"感
  const splitX = x0 + Math.round(w * 0.54);

  // 草皮
  c.rect(x0, y0, w, grassH, PAL.grass);
  for (let i = 0; i < 9; i++) {
    const gx = x0 + Math.round((i / 9) * w + (i % 2) * u * 0.4);
    c.rect(gx, y0 - Math.max(1, Math.round(u * 0.5)), Math.max(2, Math.round(u)), grassH, PAL.grass);
  }
  c.rect(x0, y0 + grassH - Math.max(1, Math.round(u * 0.7)), w, Math.max(1, Math.round(u * 0.7)), PAL.grassDark);

  // 土层（左）
  c.rect(x0, y0 + grassH, splitX - x0, dirtH, PAL.soil);
  // 土层里的颗粒
  const grains = [
    [0.10, 0.28], [0.32, 0.62], [0.17, 0.86],
  ];
  for (const [gx, gy] of grains) {
    c.rect(
      x0 + Math.round((splitX - x0) * gx),
      y0 + grassH + Math.round(dirtH * gy),
      Math.max(2, Math.round(u * 0.9)),
      Math.max(2, Math.round(u * 0.9)),
      PAL.soilDark,
    );
  }
  // 岩层（左，土下面）
  c.rect(x0, y0 + grassH + dirtH, splitX - x0, rockH, PAL.stoneDark);

  // 右半剖面：岩层
  c.rect(splitX, y0 + grassH, w - (splitX - x0), totalH - grassH, PAL.stone);
  c.rect(splitX, y0 + grassH, w - (splitX - x0), Math.max(2, Math.round(u * 0.8)), PAL.stoneDark);
  // 岩层纹理：横向断口 + 一块深色夹层
  c.rect(splitX + Math.round(w * 0.06), y0 + Math.round(totalH * 0.52), Math.round(w * 0.3), Math.max(2, Math.round(u * 0.7)), PAL.stoneDark);
  c.rect(splitX + Math.round(w * 0.14), y0 + Math.round(totalH * 0.72), Math.round(w * 0.24), Math.round(w * 0.12), PAL.soilDark);

  // 裂缝：从草皮斜向下劈开，锯齿状，越往下越亮（"地髓"在下面）
  const crack = [
    [0.43, 0.0], [0.405, 0.16], [0.45, 0.32], [0.415, 0.48], [0.455, 0.62], [0.43, 0.80], [0.445, 0.98],
  ];
  for (let i = 0; i < crack.length - 1; i++) {
    const [ax, ay] = crack[i];
    const [bx, by] = crack[i + 1];
    const segs = Math.round(totalH * 0.18);
    for (let k = 0; k < segs; k++) {
      const t = k / segs;
      const px = x0 + Math.round(w * (ax + (bx - ax) * t));
      const py = y0 + Math.round(totalH * (ay + (by - ay) * t));
      const bright = ay > 0.62;
      const wdt = Math.max(1, Math.round(u * (bright ? 0.48 : 0.32)));
      c.rect(px, py, wdt, wdt, bright ? PAL.glow : PAL.glowDark);
    }
  }
  // 裂缝底部的光核
  const coreX = x0 + Math.round(w * 0.455);
  const coreY = y0 + Math.round(totalH * 0.82);
  const coreR = Math.round(u * 1.15);
  for (let yy = -coreR; yy <= coreR; yy++) {
    for (let xx = -coreR; xx <= coreR; xx++) {
      const d = Math.hypot(xx, yy);
      if (d > coreR) continue;
      const a = Math.round(255 * (1 - d / coreR) ** 1.6);
      const i2 = ((coreY + yy) * size + (coreX + xx)) * 4;
      if (i2 < 0 || i2 >= c.px.length) continue;
      const mix = a / 255;
      c.px[i2] = Math.round(c.px[i2] * (1 - mix) + PAL.glow[0] * mix);
      c.px[i2 + 1] = Math.round(c.px[i2 + 1] * (1 - mix) + PAL.glow[1] * mix);
      c.px[i2 + 2] = Math.round(c.px[i2 + 2] * (1 - mix) + PAL.glow[2] * mix);
    }
  }

  return c;
}

function writePng(name, size, opts) {
  const c = drawIcon(size, opts);
  writeFileSync(join(OUT, name), encodePng(size, size, c.px));
  console.log(`  ${name}  ${size}×${size}`);
}

console.log('生成图标：');
writePng('icon-192.png', 192, {});
writePng('icon-512.png', 512, {});
writePng('icon-512-maskable.png', 512, { maskable: true });
writePng('apple-180.png', 180, { rounded: false });
writePng('favicon-32.png', 32, {});

// ── 安装预览截图（1280×600，宽屏）─────────────────────────
{
  const W = 1280;
  const H = 600;
  const px = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const t = y / H;
      const col = [
        Math.round(PAL.bg1[0] * (1 - t) + PAL.bg0[0] * t),
        Math.round(PAL.bg1[1] * (1 - t) + PAL.bg0[1] * t),
        Math.round(PAL.bg1[2] * (1 - t) + PAL.bg0[2] * t),
      ];
      const i = (y * W + x) * 4;
      px[i] = col[0];
      px[i + 1] = col[1];
      px[i + 2] = col[2];
      px[i + 3] = 255;
    }
  }
  const tile = 24;
  const groundY = Math.round(H * 0.62);
  const put = (x, y, c) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) * 4;
    px[i] = c[0];
    px[i + 1] = c[1];
    px[i + 2] = c[2];
  };
  // 地形条带
  for (let x = 0; x < W; x += tile) {
    const h = groundY + Math.round(Math.sin(x * 0.006) * 26);
    for (let y = h; y < H; y += tile) {
      const depth = (y - h) / tile;
      const c = depth < 1 ? PAL.grass : depth < 2.5 ? PAL.soil : y / tile > 19 ? PAL.stoneDark : PAL.stone;
      for (let yy = y; yy < Math.min(y + tile, H); yy++) for (let xx = x; xx < Math.min(x + tile, W); xx++) put(xx, yy, c);
    }
  }
  // 挖出的洞 + 青辉
  const holeX = 520;
  for (let y = groundY; y < groundY + tile * 4; y += tile) {
    for (let x = holeX; x < holeX + tile * 5; x += tile) {
      for (let yy = y; yy < y + tile; yy++) for (let xx = x; xx < x + tile; xx++) put(xx, yy, PAL.bg0);
    }
  }
  for (let i = 0; i < 90; i++) put(holeX + 30 + (i % 7) * 3, groundY + tile * 2 + i, PAL.glow);
  writeFileSync(join(OUT, 'shot-landscape.png'), encodePng(W, H, px));
  console.log(`  shot-landscape.png  ${W}×${H}`);
}

// ── SVG 版（矢量，任意尺寸都清晰）────────────────────────
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="512" height="512" role="img" aria-label="地髓">
  <defs>
    <radialGradient id="g" cx="50%" cy="42%" r="70%">
      <stop offset="0%" stop-color="#1c222e"/>
      <stop offset="100%" stop-color="#10131a"/>
    </radialGradient>
  </defs>
  <rect width="16" height="16" rx="3.4" fill="url(#g)"/>
  <rect x="2.2" y="5.6" width="8.8" height="3.2" fill="#60a858"/>
  <rect x="2.2" y="8.8" width="8.8" height="0.9" fill="#3e7a3c"/>
  <rect x="2.2" y="9.7" width="8.8" height="4.1" fill="#5c402a"/>
  <rect x="3.3" y="10.9" width="1.6" height="1" fill="#402b1c"/>
  <rect x="6.3" y="12" width="1.9" height="1" fill="#402b1c"/>
  <rect x="11.8" y="5.6" width="2" height="3.2" fill="#3e7a3c"/>
  <rect x="11.8" y="8.8" width="2" height="5" fill="#7a7e8a"/>
  <path d="M8.4 6.2 L7.6 9.4 L8.6 10.2 L7.9 13.4" stroke="#3ea89e" stroke-width="0.7" fill="none" stroke-linecap="round"/>
  <circle cx="8.9" cy="11.6" r="0.75" fill="#7ee6d6"/>
  <rect x="4" y="7" width="0.9" height="0.9" fill="#e88a52"/>
</svg>
`;
writeFileSync(join(OUT, 'icon.svg'), svg);
console.log('  icon.svg  矢量');

console.log('完成 →', OUT);
