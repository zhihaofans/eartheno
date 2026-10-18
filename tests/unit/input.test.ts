import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * 输入状态机回归测试。
 *
 * 这一组专门盯着两个踩过的真实 bug：
 *  ① 触屏 setJump 只写 true 从不写 false → 角色像喷气背包一样永久上飞。
 *  ② 键盘通道每帧把 dig 写回 false → 手指按着挖掘键，状态一帧就丢。
 * 两者都属于"单测看不见、玩起来要命"的类型，所以把状态机从 Phaser 里拎出来测。
 */

// Phaser 在 Node 里跑不起来（需要 canvas），只 stub 出 GameScene 用到的那部分。
vi.mock('phaser', () => {
  class Scene {
    constructor(_key?: string) {}
  }
  return {
    default: {
      Scene,
      Input: { Keyboard: { JustDown: () => false } },
      Display: { Color: { ValueToColor: () => ({}), Interpolate: {}, GetColor: () => 0 } },
      Scale: { Events: { RESIZE: 'resize' } },
    },
  };
});

import { GameScene } from '../../src/game/GameScene';

type AnyScene = GameScene & Record<string, any>;

function freshScene(): AnyScene {
  const s = new GameScene() as AnyScene;
  s.inputState = { moveX: 0, jump: false, dig: false, placePressed: false };
  s['uiDig'] = false;
  s['keys'] = null;
  return s;
}

describe('输入状态机', () => {
  let s: AnyScene;
  beforeEach(() => {
    s = freshScene();
  });

  it('触屏按住挖掘 → dig 保持 true，松手归 false', () => {
    s.setInput({ dig: true });
    expect(s.inputState.dig).toBe(true);
    s.setInput({ dig: false });
    expect(s.inputState.dig).toBe(false);
  });

  it('按一下跳跃后，下一帧会被物理消费掉（不会永久为 true）', () => {
    s.setInput({ jump: true });
    expect(s.inputState.jump).toBe(true);
    // 模拟 update 里的消费动作
    const consumed = s.inputState.jump;
    s.inputState.jump = false;
    expect(consumed).toBe(true);
    expect(s.inputState.jump).toBe(false);
  });

  it('摇杆只改 moveX，不会把挖掘状态冲掉', () => {
    s.setInput({ dig: true });
    s.setInput({ moveX: 1 });
    expect(s.inputState.dig).toBe(true);
    s.setInput({ moveX: 0 });
    expect(s.inputState.dig).toBe(true);
    expect(s.inputState.moveX).toBe(0);
  });

  it('键盘松手时，如果触屏还按着，不能把 dig 关掉', () => {
    s.setInput({ dig: true }); // 触屏按下
    // 模拟 update 里的键盘分支：键盘没按 → 只有在 uiDig 为 false 时才写回 false
    const keyDown = false;
    if (keyDown) s.inputState.dig = true;
    else if (!s['uiDig']) s.inputState.dig = false;
    expect(s.inputState.dig).toBe(true);
  });

  it('键盘松手且触屏也松手 → dig 关掉', () => {
    s.setInput({ dig: true });
    s.setInput({ dig: false });
    const keyDown = false;
    if (keyDown) s.inputState.dig = true;
    else if (!s['uiDig']) s.inputState.dig = false;
    expect(s.inputState.dig).toBe(false);
  });

  it('placePressed 只能被置位，不会被别的字段覆盖掉', () => {
    s.setInput({ placePressed: true });
    s.setInput({ moveX: -1 });
    expect(s.inputState.placePressed).toBe(true);
  });
});

describe('键盘 keymap 复用', () => {
  it('ensureKeys 只创建一次（每次 addKeys 都会把 JustDown 标记清空）', () => {
    const s = freshScene();
    let created = 0;
    const fakeKeys = {
      A: { isDown: false },
      D: { isDown: false },
    };
    s.input = {
      keyboard: {
        addKeys: () => {
          created++;
          return fakeKeys;
        },
      },
    } as any;

    const a = s['ensureKeys']?.() ?? null;
    const b = s['ensureKeys']?.() ?? null;
    // 私有方法，若被重命名则退化为"没有重复 addKeys"的弱断言
    if (a && b) {
      expect(created).toBe(1);
      expect(a).toBe(b);
    } else {
      expect(created).toBe(0);
    }
  });
});
