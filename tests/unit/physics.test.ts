import { describe, it, expect } from 'vitest';
import { stepBody, makeBody, tileOverlapsBody, PHYS } from '../../src/core/physics';

/** 用一组实心矩形构造世界 */
function makeSolid(rects: [number, number, number, number][]) {
  return (tx: number, ty: number) => rects.some(([x, y, w, h]) => tx >= x && tx < x + w && ty >= y && ty < y + h);
}

function sim(body: ReturnType<typeof makeBody>, solid: (x: number, y: number) => boolean, seconds: number, input = { moveX: 0, jump: false }) {
  const dt = 1 / 60;
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) stepBody(body, dt, input, solid);
  return body;
}

describe('AABB 物理', () => {
  it('自由落体后停在方块顶面，不会穿地', () => {
    const solid = makeSolid([[0, 10, 20, 2]]);
    const b = makeBody(5.5, 5);
    sim(b, solid, 3);
    expect(b.y).toBeCloseTo(10, 2);
    expect(b.onGround).toBe(true);
  });

  it('地面上的每一帧 onGround 都为 true（不自抖）', () => {
    const solid = makeSolid([[0, 10, 20, 2]]);
    const b = makeBody(5.5, 10);
    const dt = 1 / 60;
    for (let i = 0; i < 30; i++) {
      stepBody(b, dt, { moveX: 0, jump: false }, solid);
      expect(b.onGround).toBe(true);
    }
    expect(b.y).toBeCloseTo(10, 2);
  });

  it('跳跃高度够上 1 格台阶（约 1.9 tile）', () => {
    const solid = makeSolid([[0, 20, 40, 2]]);
    const b = makeBody(5.5, 20);
    stepBody(b, 1 / 60, { moveX: 0, jump: true }, solid);
    let minY = b.y;
    for (let i = 0; i < 60; i++) {
      stepBody(b, 1 / 60, { moveX: 0, jump: false }, solid);
      minY = Math.min(minY, b.y);
    }
    expect(20 - minY).toBeGreaterThan(1.6);
    expect(20 - minY).toBeLessThan(2.4);
  });

  it('自动阶梯：走向 1 格高的台阶会自己上去', () => {
    // 地面 y=10 起，台阶从图块 x=8 开始、宽 4 格，顶面在 y=9（比地面高 1 格）
    const solid = makeSolid([
      [0, 10, 40, 2],
      [8, 9, 4, 1],
    ]);
    const b = makeBody(6.5, 10);
    sim(b, solid, 0.6, { moveX: 1, jump: false });
    expect(b.x).toBeGreaterThan(8);
    expect(b.y).toBeCloseTo(9, 2);
    expect(b.onGround).toBe(true);
  });

  it('自动阶梯不会把 2 格高的墙当成台阶', () => {
    // 同样是"撞墙"，但台阶顶面在 y=8（比地面高 2 格），超出 stepHeight，必须挡住
    const solid = makeSolid([
      [0, 10, 40, 2],
      [8, 8, 1, 2],
    ]);
    const b = makeBody(6.5, 10);
    sim(b, solid, 1.0, { moveX: 1, jump: false });
    expect(b.x).toBeLessThan(8);
    expect(b.y).toBeCloseTo(10, 2);
  });

  it('2 格高的墙挡得住，不会"爬上去"', () => {
    const solid = makeSolid([
      [0, 10, 40, 2],
      [9, 8, 1, 2],
    ]);
    const b = makeBody(7, 10);
    sim(b, solid, 1.5, { moveX: 1, jump: false });
    expect(b.x).toBeLessThan(9);
    expect(b.y).toBeCloseTo(10, 2);
  });

  it('高速下落不会穿透薄地板', () => {
    const solid = makeSolid([[0, 30, 20, 1]]);
    const b = makeBody(5.5, 5);
    b.vy = 60;
    sim(b, solid, 3);
    expect(b.y).toBeCloseTo(30, 2);
  });

  it('撞天花板后垂直速度归零', () => {
    const solid = makeSolid([
      [0, 10, 20, 2],
      [0, 5, 20, 1],
    ]);
    const b = makeBody(5.5, 10);
    b.vy = -30;
    for (let i = 0; i < 30; i++) stepBody(b, 1 / 60, { moveX: 0, jump: false }, solid);
    expect(b.y).toBeGreaterThanOrEqual(6);
  });

  it('coyote time：离开平台后仍能起跳', () => {
    const solid = makeSolid([[0, 10, 6, 2]]);
    const b = makeBody(5.5, 10);
    // 先离地一小段
    stepBody(b, 1 / 60, { moveX: 1, jump: false }, solid);
    b.y -= 0.02;
    const before = b.vy;
    stepBody(b, 1 / 60, { moveX: 0, jump: true }, solid);
    expect(b.vy).toBeLessThan(0); // 起跳（向上为负）
    expect(b.vy).toBeLessThan(before);
  });

  it('放置判定：与角色重叠的格子不能放', () => {
    const b = makeBody(5.5, 10);
    expect(tileOverlapsBody(5, 8, b)).toBe(true); // 身体所在
    expect(tileOverlapsBody(8, 8, b)).toBe(false); // 远处
  });

  it('物理常数：跳跃高度 ≈ jumpV² / (2g)', () => {
    const h = (PHYS.jumpV * PHYS.jumpV) / (2 * PHYS.gravity);
    expect(h).toBeGreaterThan(1.5);
    expect(h).toBeLessThan(2.5);
  });
});
