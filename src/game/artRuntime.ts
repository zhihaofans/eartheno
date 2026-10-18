/**
 * 把程序化生成的像素画登记进 Phaser 纹理管理器（一次生成，全局复用）。
 */
import Phaser from 'phaser';
import { buildBlockTextures } from '../art/blocks';
import { buildCharacterFrames, buildToolIcons, makeGlow } from '../art/character';
import { BLOCKS } from '../core/blocks';

export const TEX = {
  block: (key: string) => `b_${key}`,
  char: (i: number) => `c_${i}`,
  icon: (kind: string) => `i_${kind}`,
  glow: 'glow',
};

function toImageData(data: Uint8ClampedArray, w: number, h: number): ImageData {
  // TS 的 ImageData 构造签名要求底层是 ArrayBuffer（SharedArrayBuffer 不行），拷贝一份最稳
  return new ImageData(new Uint8ClampedArray(data), w, h);
}

export function registerArt(scene: Phaser.Scene): void {
  const blocks = buildBlockTextures();
  for (const b of BLOCKS) {
    if (b.key === 'air') continue;
    const px = blocks.get(b.key);
    if (!px) continue;
    const key = TEX.block(b.key);
    if (scene.textures.exists(key)) continue;
    scene.textures.createCanvas(key, 16, 16);
    const tex = scene.textures.get(key).getSourceImage() as HTMLCanvasElement;
    const ctx = tex.getContext('2d')!;
    ctx.putImageData(toImageData(px, 16, 16), 0, 0);
    (scene.textures.get(key).source[0] as Phaser.Textures.TextureSource).update();
  }

  const frames = buildCharacterFrames();
  frames.forEach((f, i) => {
    const key = TEX.char(i);
    if (scene.textures.exists(key)) return;
    scene.textures.createCanvas(key, f.w, f.h);
    const cv = scene.textures.get(key).getSourceImage() as HTMLCanvasElement;
    cv.getContext('2d')!.putImageData(toImageData(f.data, f.w, f.h), 0, 0);
    (scene.textures.get(key).source[0] as Phaser.Textures.TextureSource).update();
  });

  const icons = buildToolIcons();
  for (const [k, f] of Object.entries(icons)) {
    const key = TEX.icon(k);
    if (scene.textures.exists(key)) return;
    scene.textures.createCanvas(key, f.w, f.h);
    const cv = scene.textures.get(key).getSourceImage() as HTMLCanvasElement;
    cv.getContext('2d')!.putImageData(toImageData(f.data, f.w, f.h), 0, 0);
    (scene.textures.get(key).source[0] as Phaser.Textures.TextureSource).update();
  }

  if (!scene.textures.exists(TEX.glow)) {
    const g = makeGlow(32);
    scene.textures.createCanvas(TEX.glow, g.w, g.h);
    const cv = scene.textures.get(TEX.glow).getSourceImage() as HTMLCanvasElement;
    cv.getContext('2d')!.putImageData(toImageData(g.data, g.w, g.h), 0, 0);
    (scene.textures.get(TEX.glow).source[0] as Phaser.Textures.TextureSource).update();
  }

  // 脚下投影：一张 16×6 的柔和椭圆，比 ellipse 图形省一次绘制开销
  if (!scene.textures.exists('shadow')) {
    const w = 16;
    const h = 6;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const dx = (x - w / 2 + 0.5) / (w / 2);
        const dy = (y - h / 2 + 0.5) / (h / 2);
        const d = dx * dx + dy * dy;
        const i = (y * w + x) * 4;
        data[i] = 10;
        data[i + 1] = 8;
        data[i + 2] = 12;
        data[i + 3] = d >= 1 ? 0 : (1 - d) * 255;
      }
    }
    scene.textures.createCanvas('shadow', w, h);
    const cv = scene.textures.get('shadow').getSourceImage() as HTMLCanvasElement;
    cv.getContext('2d')!.putImageData(toImageData(data, w, h), 0, 0);
    (scene.textures.get('shadow').source[0] as Phaser.Textures.TextureSource).update();
  }
}
