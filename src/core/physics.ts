/**
 * 角色 AABB 物理：分轴扫掠 + 自动阶梯。
 *
 * 不依赖 Phaser Arcade，原因：
 * ① 纯函数可单测（"地面每一帧都算站在地上""跳得上 1 格台阶"这些必须自动化）；
 * ② 自动阶梯是非标准行为，改 Arcade 反而更绕。
 *
 * 坐标单位 = tile；角色原点是「脚底中心」。
 *
 * 落地模型（这里踩过坑，规则都固化成了 tests/unit/physics.test.ts 的用例）：
 * - 「站在地上」不靠"这一步位移撞没撞"：贴地那一帧位移是 0，会算出没落地，
 *   于是 onGround 抖成 false，自动阶梯和 coyote 全部失效。
 * - 统一由 settle() 在每帧末尾判定：脚底向下探 1/500 格探到实心块 → 吸附到该块顶面。
 *   吸附时留 1/1000 内缩：整数坐标正好压在格线上时，浮点误差会让下一次探测落回上一格。
 */
export interface Body {
  x: number;
  y: number;
  vx: number;
  vy: number;
  w: number;
  h: number;
  onGround: boolean;
  /** 离开地面后仍允许起跳的剩余时间（秒） */
  coyote: number;
  /** 提前按跳的缓存时间（秒） */
  jumpBuffer: number;
  facing: -1 | 1;
}

export const PHYS = {
  gravity: 34,
  /** 峰值高度 ≈ jumpV²/(2g) ≈ 1.98 tile → 跳得上 1 格台阶 */
  jumpV: 11.6,
  maxFall: 32,
  walkAccel: 90,
  airAccel: 46,
  friction: 70,
  maxSpeed: 6.2,
  coyoteTime: 0.08,
  jumpBufferTime: 0.1,
  stepHeight: 1,
};

/**
 * 脚底探测距离：1/50 格（0.32 像素）。
 *
 * 不能更小：渲染层开了 roundPixels，角色会被取整到整数像素，
 * 脚底可能在画面上陷进方块半个像素 —— 探测距离必须覆盖这段肉眼误差，
 * 否则玩家会看到脚陷进地里，且物理判成"没落地"（踩过）。
 */
const PROBE = 0.02;
/** 吸附内缩 */
const SKIN = 0.001;
/** 盒子内缩，避免浮点误差把"贴着墙"判成"卡进墙" */
const EPS = 1e-4;

export function makeBody(x: number, y: number): Body {
  return { x, y, vx: 0, vy: 0, w: 0.6, h: 1.8, onGround: false, coyote: 0, jumpBuffer: 0, facing: 1 };
}

export type SolidFn = (tx: number, ty: number) => boolean;

function overlapsSolid(x: number, y: number, body: Body, solid: SolidFn): boolean {
  const l = Math.floor(x - body.w / 2 + EPS);
  const r = Math.floor(x + body.w / 2 - EPS);
  const t = Math.floor(y - body.h + EPS);
  const b = Math.floor(y - EPS);
  for (let ty = t; ty <= b; ty++) for (let tx = l; tx <= r; tx++) if (solid(tx, ty)) return true;
  return false;
}

/** 两脚（左右 1/4 处）下方是否各踩在实心块上 */
function feetOn(body: Body, y: number, solid: SolidFn): boolean {
  const tile = Math.floor(y + PROBE);
  return solid(Math.floor(body.x - body.w / 4), tile) || solid(Math.floor(body.x + body.w / 4), tile);
}

/**
 * 每帧末尾调用：唯一决定 onGround 的地方。
 *
 * 落地有两种来源，缺一不可：
 * ① 位移被方块挡住（moveY 返回 blocked）→ 直接贴到方块顶面。这是"精准落地"，优先；
 * ② 下落位移为 0 时，脚底向下探 PROBE，探到就吸附（兜住浮点残差：0.5333 的位移
 *    会让角色停在 0.008 格的小缝里，不处理就会一直"悬空"、onGround 抖动）。
 */
function settle(
  body: Body,
  solid: SolidFn,
  dy: number,
  blocked: boolean,
): { landed: boolean; fallSpeed: number } {
  const fallSpeed = body.vy;
  let grounded = false;
  if (blocked && dy > 0) {
    // ② 精确落地：移动到方块顶面
    const tile = Math.floor(body.y + PROBE);
    body.y = tile - SKIN;
    grounded = true;
  } else if (dy >= 0 && body.vy >= 0 && feetOn(body, body.y, solid)) {
    const tile = Math.floor(body.y + PROBE);
    body.y = tile - SKIN;
    grounded = true;
  }
  if (grounded) {
    body.vy = 0;
    const wasAir = !body.onGround;
    body.onGround = true;
    return { landed: wasAir, fallSpeed };
  }
  body.onGround = false;
  return { landed: false, fallSpeed };
}

export interface MoveInput {
  moveX: number;
  jump: boolean;
}

export interface MoveResult {
  landed: boolean;
  jumped: boolean;
  hitWall: boolean;
  fallSpeed: number;
}

/**
 * 求"前方那一列"上、角色能站上去的台阶顶面（世界格线坐标）。前方没有可站的方块返回 Infinity。
 *
 * 这里把语义抠死，因为它是整段自动阶梯里最容易写错的一处：
 * 体节坐标 body.y 是**脚底**，站在地面上时 body.y ≈ 9.999（被 settle 吸附到格线下 0.001），
 * 于是 base = floor(y) = 9 —— 这一格正是"脚底所在格"，也是台阶本体所在的格。
 * 格子 ty 的顶面就是格线 ty，所以「col[base] 是实心」就意味着站上去是 y=base。
 *
 * 踩过的两个错版本（都写进了单测）：
 * ① 找第一块实心格再返回 ty+1 → 贴着墙时 col[base] 就是实心，ty+1 = base+1 在头顶上，
 *    被"必须低于脚底"的条件拒掉，角色就永远贴着墙原地踏步。
 * ② 从 base-1 起扫 → 下方恰好是空地时直接扫穿，同样什么都找不到。
 */
function groundAhead(body: Body, nx: number, sign: number, solid: SolidFn): number {
  const col = Math.floor(nx + sign * (body.w / 2 + STEP_PROBE));
  const base = Math.floor(body.y - EPS);
  for (let ty = base; ty >= base - PHYS.stepHeight; ty--) {
    if (solid(col, ty)) return ty; // 格子 ty 的顶面 == 格线 ty
  }
  return Infinity; // 前方是深坑，或者台阶太高，不爬
}

/**
 * 自动阶梯：撞到 PHYS.stepHeight 格以内的台阶时自动抬腿上去。
 *
 * 另外两个坑：
 * ① 判定用的探测列要比身体前边缘再往外多探 STEP_PROBE 格。按 1/16 格逼近会停在 7.99，
 *    前边缘差 0.001 格没进方块列，直接用"前边缘列"会恒为假。
 * ② 抬腿必须"先抬 y、再推 x"，且推完要校验；不能只抬 y（会嵌在台阶侧面里），
 *    也不能只推 x（推不动）。任何一步不成立就整体回滚，避免角色卡在半空。
 * ③ 只有在地面（或 coyote 窗口内）才抬腿，空中撞墙不能"爬"上去。
 */
const STEP_PROBE = 0.05;

function tryStepUp(body: Body, nx: number, sign: number, solid: SolidFn): boolean {
  if (!body.onGround && body.coyote <= 0) return false;
  const top = groundAhead(body, nx, sign, solid);
  if (!isFinite(top)) return false;
  // 台阶必须低于脚底，且落差不超过 stepHeight
  if (top > body.y + PROBE) return false;
  if (body.y - top > PHYS.stepHeight + PROBE * 2) return false;

  const sx = body.x;
  const sy = body.y;
  const targetY = top - SKIN;
  body.y = targetY;
  if (overlapsSolid(nx, targetY, body, solid)) {
    body.x = sx;
    body.y = sy;
    return false;
  }
  body.x = nx;
  body.vy = 0;
  return true;
}

function moveX(body: Body, dx: number, solid: SolidFn): boolean {
  if (dx === 0) return false;
  const sign = Math.sign(dx);
  const nx = body.x + dx;
  if (!overlapsSolid(nx, body.y, body, solid)) {
    body.x = nx;
    return false;
  }
  if (tryStepUp(body, nx, sign, solid)) return false;
  // 贴墙：按 1/16 格逼近，停在墙边
  const step = sign / 16;
  for (let i = 0; i < 16; i++) {
    if (overlapsSolid(body.x + step, body.y, body, solid)) break;
    body.x += step;
  }
  return true;
}

function moveY(body: Body, dy: number, solid: SolidFn): { hitHead: boolean; blocked: boolean } {
  if (dy === 0) return { hitHead: false, blocked: false };
  const ny = body.y + dy;
  if (!overlapsSolid(body.x, ny, body, solid)) {
    body.y = ny;
    return { hitHead: false, blocked: false };
  }
  const step = Math.sign(dy) / 16;
  let hit = false;
  for (let i = 0; i < 16; i++) {
    if (overlapsSolid(body.x, body.y + step, body, solid)) {
      hit = true;
      break;
    }
    body.y += step;
  }
  return { hitHead: hit && dy < 0, blocked: hit };
}

export function stepBody(body: Body, dt: number, input: MoveInput, solid: SolidFn): MoveResult {
  const res: MoveResult = { landed: false, jumped: false, hitWall: false, fallSpeed: 0 };
  dt = Math.min(dt, 1 / 30); // 掉帧时不模拟巨大步长（会穿墙）

  // 计时器
  body.coyote = body.onGround ? PHYS.coyoteTime : Math.max(0, body.coyote - dt);
  body.jumpBuffer = input.jump ? PHYS.jumpBufferTime : Math.max(0, body.jumpBuffer - dt);

  // 水平速度
  const accel = body.onGround ? PHYS.walkAccel : PHYS.airAccel;
  const target = input.moveX * PHYS.maxSpeed;
  if (Math.abs(input.moveX) > 0.05) {
    const dv = target - body.vx;
    body.vx += Math.sign(dv) * Math.min(Math.abs(dv), accel * dt);
    body.facing = input.moveX > 0 ? 1 : -1;
  } else {
    const f = (body.onGround ? PHYS.friction : PHYS.friction * 0.15) * dt;
    body.vx = Math.abs(body.vx) <= f ? 0 : body.vx - Math.sign(body.vx) * f;
  }

  // 跳跃（coyote + buffer）
  if (body.jumpBuffer > 0 && body.coyote > 0) {
    body.vy = -PHYS.jumpV;
    body.jumpBuffer = 0;
    body.coyote = 0;
    body.onGround = false;
    res.jumped = true;
  }

  // 重力
  body.vy = Math.min(PHYS.maxFall, body.vy + PHYS.gravity * dt);

  // 分轴移动
  res.hitWall = moveX(body, body.vx * dt, solid);
  if (res.hitWall) body.vx = 0;
  const dyStep = body.vy * dt;
  const yRes = moveY(body, dyStep, solid);
  if (yRes.hitHead) body.vy = Math.max(body.vy, 0);

  // 落地结算（唯一一处决定 onGround）
  const s = settle(body, solid, dyStep, yRes.blocked);
  if (!s.landed && body.vy > 40) body.vy = 40; // 兜底：超过 40 tile/s 才可能一步跨过一格

  // 贴地吸附：站在地上时把亚像素残余抹平（渲染层开着 roundPixels，视觉上才不抖）
  if (body.onGround && Math.abs(body.y - Math.round(body.y)) < 0.03) {
    const snapped = Math.round(body.y) - SKIN;
    if (feetOn(body, snapped, solid)) body.y = snapped;
  }
  res.landed = s.landed;
  res.fallSpeed = s.fallSpeed;
  return res;
}

/** 某个 tile 是否会被角色身体占住（放置方块时的防卡判定） */
export function tileOverlapsBody(tx: number, ty: number, body: Body): boolean {
  const bl = body.x - body.w / 2;
  const br = body.x + body.w / 2;
  const bt = body.y - body.h;
  const bb = body.y;
  return tx < br && tx + 1 > bl && ty < bb && ty + 1 > bt;
}
