/**
 * 地髓 Eartheno — 核心纯逻辑层。
 * 这一层不 import phaser，全部可以在 Node 里单测。
 */

export const TILE = 16;
export const CHUNK = 32;
export const CHUNK_AREA = CHUNK * CHUNK;

/**
 * 世界边界（chunk 坐标，含端点）。
 *
 * cyMin = -2 是**必须**的，不是随手给的余量：
 * 早期写成 0 时，第 0 行区块就是"世界顶"—— chunk 之外的一切按规则都会被当成
 * 不可见的虚空，于是走到稍微高一点的地方，头顶和远处的整片地形就"消失"了，
 * 只剩一块孤零零的地面挂在屏幕上（这也是"到一定高度后地面消失"的真正原因）。
 * 现在向上留 2 行（64 格）空气，任何跳跃高度都在空气里，天上再不会被削平。
 */
export const WORLD = {
  cxMin: -256,
  cxMax: 255,
  cyMin: -2,
  cyMax: 8,
} as const;

/** 世界顶部（含）的 tile 行号。头顶这一行以上什么都没有，但玩家永远摸不到它 */
export const WORLD_TOP = WORLD.cyMin * CHUNK;

/**
 * 存档格式号（整数，只增不减）。
 *
 * 和 `package.json` 的 version 是两回事：version 给人和更新提示用，fmt 给迁移代码用。
 * 改了**语义**（比如世界顶部上移两行、新增方块 id 的分布）就要抬这个号，
 * 并在 save.ts 里补一条迁移；只是加 UI、调手感则不用动它。
 *
 * 1 → 2：WORLD.cyMin 从 0 改成 -2，老存档需要清空天空两行（见 migrateSkyRows）。
 */
export const SAVE_FMT = 2;
export const APP_ID = 'eartheno';
