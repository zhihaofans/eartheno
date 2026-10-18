/**
 * 程序化美术：方块纹理。
 *
 * 全部用代码画 16×16 像素（原作美术，不引用任何外部素材）。
 * 每张纹理用「主色 + 明暗抖动 + 少数点缀」的方式生成，种子固定 → 每次启动一模一样。
 */
import { mulberry32 } from '../core/rng';
import { BLOCKS } from '../core/blocks';

export const TILE_PX = 16;

type RGB = [number, number, number];

interface Palette {
  base: RGB;
  dark: RGB;
  light: RGB;
  accent?: RGB;
  /** 纹理风格 */
  style: 'soil' | 'grass' | 'stone' | 'ore' | 'crystal' | 'wood' | 'brick' | 'plank' | 'glow' | 'none' | 'bedrock';
  accentDensity?: number;
}

const PAL: Record<string, Palette> = {
  air: { base: [0, 0, 0], dark: [0, 0, 0], light: [0, 0, 0], style: 'none' },
  grass: { base: [86, 120, 62], dark: [58, 88, 44], light: [118, 156, 78], accent: [46, 74, 52], style: 'grass' },
  dirt: { base: [124, 92, 62], dark: [96, 68, 44], light: [150, 114, 78], style: 'soil' },
  stone: { base: [116, 116, 124], dark: [88, 88, 96], light: [144, 144, 152], style: 'stone' },
  cobble: { base: [128, 128, 134], dark: [92, 92, 98], light: [158, 158, 164], style: 'brick' },
  clay: { base: [168, 104, 74], dark: [132, 76, 54], light: [192, 128, 92], style: 'soil' },
  brick: { base: [158, 92, 72], dark: [112, 62, 50], light: [190, 124, 96], style: 'brick' },
  wood: { base: [112, 82, 52], dark: [78, 56, 34], light: [140, 106, 68], style: 'wood' },
  flint: { base: [74, 74, 86], dark: [50, 50, 60], light: [110, 110, 124], accent: [150, 150, 168], style: 'stone' },
  copper: { base: [120, 122, 128], dark: [90, 92, 98], light: [150, 152, 158], accent: [198, 122, 66], style: 'ore', accentDensity: 0.09 },
  ember: { base: [96, 88, 86], dark: [64, 58, 58], light: [130, 118, 112], accent: [244, 138, 54], style: 'glow', accentDensity: 0.07 },
  glow: { base: [66, 84, 96], dark: [44, 58, 70], light: [96, 124, 140], accent: [120, 236, 226], style: 'crystal', accentDensity: 0.12 },
  plank: { base: [176, 146, 98], dark: [136, 110, 72], light: [204, 176, 126], style: 'plank' },
  torch: { base: [0, 0, 0], dark: [120, 94, 62], light: [0, 0, 0], accent: [255, 190, 90], style: 'wood' },
  crystal: { base: [110, 160, 176], dark: [78, 122, 140], light: [164, 210, 224], accent: [226, 252, 255], style: 'crystal', accentDensity: 0.05 },
  bedrock: { base: [46, 44, 48], dark: [30, 28, 32], light: [72, 70, 78], style: 'bedrock' },
};

function shade(c: RGB, k: number): RGB {
  return [Math.min(255, c[0] * k), Math.min(255, c[1] * k), Math.min(255, c[2] * k)];
}

/** 生成一张 16×16 RGBA 图 */
export function makeBlockPixels(key: string): Uint8ClampedArray {
  const p = PAL[key] ?? PAL.stone;
  const out = new Uint8ClampedArray(TILE_PX * TILE_PX * 4);
  if (p.style === 'none') return out;
  const rnd = mulberry32(key.length * 7919 + key.charCodeAt(0) * 131 + 17);
  const px = (x: number, y: number, c: RGB, a = 255) => {
    if (x < 0 || y < 0 || x >= TILE_PX || y >= TILE_PX) return;
    const i = (y * TILE_PX + x) * 4;
    out[i] = c[0];
    out[i + 1] = c[1];
    out[i + 2] = c[2];
    out[i + 3] = a;
  };

  if (key === 'torch') {
    // 火把：一根斜木杆 + 火焰（透明底）
    for (let y = 4; y < 16; y++) {
      const x = 8 + Math.round((y - 4) * 0.12);
      px(x, y, p.dark);
      px(x + 1, y, shade(p.dark, 1.25));
    }
    const flame: string[] = ['..oo..', '.oyyo.', 'oywwyo', '.oyyo.', '..oo..'];
    const col: Record<string, RGB> = { o: [240, 120, 40], y: [255, 196, 80], w: [255, 246, 210] };
    flame.forEach((row, ry) => {
      for (let rx = 0; rx < row.length; rx++) {
        const ch = row[rx];
        if (ch !== '.') px(5 + rx, ry - 1, col[ch]);
      }
    });
    return out;
  }

  // 底色 + 明暗抖动
  for (let y = 0; y < TILE_PX; y++) {
    for (let x = 0; x < TILE_PX; x++) {
      let c = p.base;
      const r = rnd();
      if (p.style === 'soil') {
        if (r < 0.22) c = p.dark;
        else if (r < 0.34) c = p.light;
      } else if (p.style === 'stone' || p.style === 'ore' || p.style === 'glow') {
        if (r < 0.16) c = p.dark;
        else if (r < 0.28) c = p.light;
      } else if (p.style === 'brick' || p.style === 'plank') {
        c = p.base;
      } else if (p.style === 'grass') {
        if (r < 0.18) c = p.dark;
        else if (r < 0.3) c = p.light;
      } else if (p.style === 'wood') {
        if (r < 0.2) c = p.dark;
        else if (r < 0.28) c = p.light;
      } else if (p.style === 'crystal') {
        if (r < 0.15) c = p.dark;
        else if (r < 0.3) c = p.light;
      } else if (p.style === 'bedrock') {
        c = r < 0.35 ? p.dark : r < 0.6 ? p.light : p.base;
      }
      px(x, y, c);
    }
  }

  // 风格细节
  switch (p.style) {
    case 'grass': {
      // 顶部 4 行草皮 + 参差的边缘
      for (let x = 0; x < TILE_PX; x++) {
        const h = 3 + Math.floor(rnd() * 3);
        for (let y = 0; y < h; y++) {
          const c = y === 0 ? shade(p.base, 1.18) : rnd() < 0.3 ? p.dark : p.base;
          px(x, y, c);
        }
        if (h < 6) px(x, h, p.accent ?? p.dark);
      }
      break;
    }
    case 'brick': {
      const mortar = shade(p.dark, 0.8);
      for (let y = 0; y < TILE_PX; y++) {
        for (let x = 0; x < TILE_PX; x++) {
          const row = Math.floor(y / 4);
          const off = row % 2 === 0 ? 0 : 4;
          if (y % 4 === 0 || (x + off) % 8 === 0) px(x, y, mortar);
          else if (y % 4 === 1 && (x + off) % 8 === 1) px(x, y, p.light);
        }
      }
      break;
    }
    case 'plank': {
      for (let y = 0; y < TILE_PX; y++) for (let x = 0; x < TILE_PX; x++) {
        if (y % 5 === 0) px(x, y, p.dark);
        else if ((y + Math.floor(x / 4)) % 5 === 1) px(x, y, p.light);
      }
      break;
    }
    case 'wood': {
      for (let y = 0; y < TILE_PX; y++) for (let x = 0; x < TILE_PX; x++) {
        if (x % 5 === 0) px(x, y, p.dark);
      }
      for (let y = 2; y < 14; y++) px(7, y, shade(p.dark, 0.85));
      break;
    }
    case 'ore':
    case 'glow':
    case 'crystal': {
      const n = Math.floor(TILE_PX * TILE_PX * (p.accentDensity ?? 0.08));
      for (let i = 0; i < n; i++) {
        // 成团分布：先取随机种子点，再在其周围点几下
        const cx = 2 + Math.floor(rnd() * 12);
        const cy = 2 + Math.floor(rnd() * 12);
        const size = 1 + Math.floor(rnd() * 3);
        for (let k = 0; k < size; k++) {
          const dx = Math.round(rnd() * 2 - 1);
          const dy = Math.round(rnd() * 2 - 1);
          px(cx + dx, cy + dy, p.accent!);
        }
        px(cx, cy - 1, shade(p.accent!, 1.25));
      }
      if (p.style === 'crystal') {
        // 晶体棱线
        for (let i = 0; i < 3; i++) {
          const sx = Math.floor(rnd() * 16);
          for (let y = 0; y < 16; y++) px((sx + y) % 16, y, p.light);
        }
      }
      break;
    }
    case 'stone': {
      // 几道裂缝
      for (let i = 0; i < 3; i++) {
        let x = Math.floor(rnd() * 16);
        let y = Math.floor(rnd() * 16);
        for (let k = 0; k < 6; k++) {
          px(x, y, p.dark);
          x += rnd() < 0.5 ? 1 : 0;
          y += 1;
        }
      }
      break;
    }
    case 'soil': {
      for (let i = 0; i < 10; i++) {
        const x = Math.floor(rnd() * 16);
        const y = Math.floor(rnd() * 16);
        px(x, y, p.dark);
        px(x + 1, y, p.light);
      }
      break;
    }
    default:
      break;
  }
  return out;
}

/** 生成全部方块纹理：{ key → ImageData 兼容的像素数组 } */
export function buildBlockTextures(): Map<string, Uint8ClampedArray> {
  const m = new Map<string, Uint8ClampedArray>();
  for (const b of BLOCKS) m.set(b.key, makeBlockPixels(b.key));
  return m;
}
