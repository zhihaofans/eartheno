/**
 * 地髓 Eartheno — 核心纯逻辑层。
 * 这一层不 import phaser，全部可以在 Node 里单测。
 */

export const TILE = 16;
export const CHUNK = 32;
export const CHUNK_AREA = CHUNK * CHUNK;

/** 世界边界（chunk 坐标，含端点） */
export const WORLD = {
  cxMin: -256,
  cxMax: 255,
  cyMin: 0,
  cyMax: 8,
} as const;

export const SAVE_FMT = 1;
export const APP_ID = 'eartheno';
