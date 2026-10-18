/**
 * 主场景：相机、世界渲染、玩家、挖放交互。
 *
 * 分层（经验文档 §4：渲染函数之间禁止互调，统一入口）：
 *   数据（World / Inventory）
 *   → 计算（chunk 视图、可见范围）
 *   → 渲染（this.render*）
 * 世界数据变了只做「标脏」，下一帧统一重绘；UI 刷新由 main 的帧循环一次性推。
 */
import Phaser from 'phaser';
import { AIR, blockById, blockByKey, type BlockDef } from '../core/blocks';
import { CHUNK, TILE, WORLD } from '../core/constants';
import { add, autoHotbar, count, remove, toolTier, wearTool, type InventoryData } from '../core/inventory';
import { makeBody, stepBody, tileOverlapsBody, type Body } from '../core/physics';
import { toolById } from '../core/recipes';
import { SEA_LEVEL } from '../core/terrain';
import { clamp } from '../core/util';
import { TEX } from './artRuntime';
import type { World } from './world';

export interface GameSettings {
  digHoldMs: number;
  quality: 'auto' | 'high' | 'mid' | 'low';
  haptics: boolean;
}

export interface GameServices {
  settings: () => GameSettings;
  sound: {
    dig(): void;
    breakBlock(): void;
    place(): void;
    jump(): void;
    land(): void;
    error(): void;
    toolBreak(): void;
    tick(): void;
  };
  vibrate: (ms?: number) => void;
  toast: (msg: string, kind?: 'ok' | 'warn') => void;
  requestUiSync: () => void;
  onDirty: () => void;
  onDepth: (d: number) => void;
  setActiveSlot: (i: number) => void;
}

export interface InputState {
  moveX: number;
  jump: boolean;
  dig: boolean;
  placePressed: boolean;
}

interface ChunkView {
  key: string;
  cx: number;
  cy: number;
  canvas: HTMLCanvasElement;
  image: Phaser.GameObjects.Image;
  dirty: boolean;
  lastUsed: number;
  /** 是否为视口外的"背景层"（见 styleFar） */
  far: boolean;
}

const VIEW_CAP = 24;
const VIEW_CAP_LOW = 14;

export class GameScene extends Phaser.Scene {
  world!: World;
  inv!: InventoryData;
  body!: Body;
  svc!: GameServices;
  activeSlot = 0;

  inputState: InputState = { moveX: 0, jump: false, dig: false, placePressed: false };
  /** 触屏挖掘键是否按着（与键盘状态分开记，避免两边互相覆盖） */
  private uiDig = false;

  private views = new Map<string, ChunkView>();
  private viewCap = VIEW_CAP;
  private tileCanvas = new Map<string, HTMLCanvasElement>();

  private playerImg!: Phaser.GameObjects.Image;
  /** 脚下的椭圆投影：没有它，角色看起来像"贴"在地面上 */
  private shadowImg!: Phaser.GameObjects.Image;
  private heldImg!: Phaser.GameObjects.Image;
  private selectRect!: Phaser.GameObjects.Rectangle;
  private crack!: Phaser.GameObjects.Graphics;
  private darkness!: Phaser.GameObjects.Graphics;
  private bg!: Phaser.GameObjects.Graphics;
  /** 远景山脊图层（重绘背景时先销毁再重建） */
  private bgLayers: Phaser.GameObjects.Graphics[] = [];
  private pImg: Phaser.GameObjects.Image[] = [];
  private pVel: { x: number; y: number; life: number }[] = [];

  private animT = 0;
  private animFrame = 0;

  private digTarget: { tx: number; ty: number } | null = null;
  private digProgress = 0;
  private digAcc = 0;
  private digStarted = false;

  /** 上一帧的时长（ms），用于累计游玩时间 */
  lastLoopMs = 0;
  /** 键盘（桌面调试用） */
  private keys: Record<string, Phaser.Input.Keyboard.Key> | null = null;

  /** 帧率 */
  fps = 0;
  private fpsBuf: number[] = [];
  private lowStreak = 0;
  quality: 'high' | 'mid' | 'low' = 'high';
  private dirtyNotice = false;

  constructor() {
    super('game');
  }

  init(data: { world: World; inv: InventoryData; body: Body; svc: GameServices; activeSlot: number }): void {
    this.world = data.world;
    this.inv = data.inv;
    this.body = data.body;
    this.svc = data.svc;
    this.activeSlot = data.activeSlot;
    this.inputState = { moveX: 0, jump: false, dig: false, placePressed: false };
    this.views.clear();
    this.digTarget = null;
    this.digProgress = 0;
  }

  create(): void {
    // 背景
    this.bg = this.add.graphics().setDepth(-20).setScrollFactor(0.15);

    this.selectRect = this.add
      .rectangle(0, 0, TILE, TILE)
      .setStrokeStyle(1, 0xffe2a8, 0.85)
      .setFillStyle(0xffe2a8, 0.06)
      .setDepth(30) // 压在暗层之上：地底也看得见自己瞄的是哪一格
      .setVisible(false);
    this.crack = this.add.graphics().setDepth(30); // 压在暗层之上：挖的时候一定看得见裂纹
    this.shadowImg = this.add.image(this.body.x * TILE, this.body.y * TILE, 'shadow').setDepth(18).setAlpha(0.34).setScale(0.9, 0.9);
    this.playerImg = this.add.image(this.body.x * TILE, this.body.y * TILE, 'c_0').setOrigin(0.5, 1).setDepth(29);
    this.heldImg = this.add.image(0, 0, TEX.icon('pick')).setDepth(30).setVisible(false);
    // 注意：**不要** setScrollFactor(0)。暗层放在世界空间、每帧跟随相机视口重绘，
    // 这样所有坐标都是世界像素，不需要任何 screen↔world 换算（那个换算在 zoom+lerp 下极难对齐）。
    this.darkness = this.add.graphics().setDepth(28);

    for (let i = 0; i < 20; i++) {
      const p = this.add.image(0, 0, 'b_dirt').setDepth(15).setVisible(false).setScale(0.4);
      this.pImg.push(p);
      this.pVel.push({ x: 0, y: 0, life: 0 });
    }

    this.applyZoom();
    const cam = this.cameras.main;
    cam.setBackgroundColor('#1b1614');
    cam.setRoundPixels(true);
    cam.startFollow(this.playerImg, true, 0.28, 0.5);
    cam.centerOn(this.body.x * TILE, this.body.y * TILE);

    this.quality = this.svc.settings().quality === 'auto' ? 'high' : (this.svc.settings().quality as any);
    this.applyQuality();
    this.redrawBackground();
    this.scale.on(Phaser.Scale.Events.RESIZE, () => {
      this.applyZoom();
      this.redrawBackground();
    });
  }

  // ── 输入 ─────────────────────────────────────────────

  /**
   * 触屏/摇杆输入入口。
   *
   * 踩过的坑：事件里只推"变了的那个字段"，但 GameScene 每帧会重置瞬时输入
   * （jump / placePressed）。触屏 setJump 用的是 `down && setInput({jump:true})`，
   * 没有任何一处把 jump 写回 false —— 于是 jupm 一旦为 true 就永久为 true，
   * 角色会像喷气背包一样自己往上飞。这里统一收口：jump 与 placePressed 都由
   * 本方法自己维护生命周期，调用方只表达"现在按下了"。
   */
  setInput(patch: Partial<InputState>): void {
    if (patch.dig !== undefined) this.uiDig = patch.dig;
    if (patch.jump !== undefined) this.inputState.jump = patch.jump;
    if (patch.moveX !== undefined) this.inputState.moveX = patch.moveX;
    // placePressed 交给 update 处理完就清，这里最多置位
    if (patch.placePressed) this.inputState.placePressed = true;
    if (patch.dig !== undefined) this.inputState.dig = patch.dig;
  }

  /**
   * 键盘只取一次。
   *
   * 踩过的坑：以前在 update() 里每帧 `addKeys(...)`。Phaser 的 addKeys 每次都会
   * `new Key()` 并把新对象写进 keyMap，于是 `JustDown` 依赖的 `_justDown` 标记
   * 每帧被清空（跳跃、放方块在桌面端全失灵）；更隐蔽的是 Key 的 `isDown` 走
   * `_repeatCounter`，也会被重置 —— 长按判定时会误判成"松手"，
   * 把触屏摇杆/按钮的输入一起冲掉。键盘输入通道会污染触控通道，这个 bug 很难查。
   */
  private ensureKeys(): Record<string, Phaser.Input.Keyboard.Key> {
    if (!this.keys && this.input.keyboard) {
      this.keys = this.input.keyboard.addKeys(
        'A,D,LEFT,RIGHT,SPACE,W,UP,S,Z,X,ONE,TWO,THREE,FOUR,FIVE,SIX,E,ESC',
      ) as Record<string, Phaser.Input.Keyboard.Key>;
    }
    return this.keys ?? {};
  }

  // ── 主循环 ───────────────────────────────────────────

  update(_t: number, deltaMs: number): void {
    const dt = Math.min(deltaMs / 1000, 0.05);
    const { body, world, svc } = this;

    // 键盘（桌面调试）
    const kbd = this.ensureKeys();
    let kx = 0;
    let jumpHeld = false;
    {
      if (kbd.A?.isDown || kbd.LEFT?.isDown) kx -= 1;
      if (kbd.D?.isDown || kbd.RIGHT?.isDown) kx += 1;
      jumpHeld = !!(kbd.SPACE?.isDown || kbd.W?.isDown || kbd.UP?.isDown);
      // 旧逻辑是 `digDown !== inputState.dig` 才写回，但键盘"没按"时每帧都会把
      // 触屏按住的状态写成 false（手指按着挖掘键，状态一帧就没了）。
      // 改成两个来源取"或"：键盘按下 → true；键盘松手 → 只在没有触屏操作时改。
      if (kbd.S && kbd.S.isDown) this.inputState.dig = true;
      else if (kbd.Z?.isDown) this.inputState.dig = true;
      else if (!this.uiDig) this.inputState.dig = false;
      if (kbd.X && Phaser.Input.Keyboard.JustDown(kbd.X)) this.inputState.placePressed = true;
      if (kbd.E && Phaser.Input.Keyboard.JustDown(kbd.E)) this.svc.requestUiSync();
      const nums = ['ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX'];
      nums.forEach((n, i) => {
        const key = kbd[n];
        if (key && Phaser.Input.Keyboard.JustDown(key)) svc.setActiveSlot(i);
      });
      if (kbd.ESC && Phaser.Input.Keyboard.JustDown(kbd.ESC)) svc.requestUiSync();
    }
    const moveX = this.inputState.moveX !== 0 ? this.inputState.moveX : kx;

    // 物理
    const res = stepBody(body, dt, { moveX, jump: this.inputState.jump || jumpHeld }, world.isSolid);
    this.inputState.jump = false;    if (res.jumped) svc.sound.jump();
    if (res.landed && res.fallSpeed > 9) {
      svc.sound.land();
      this.burst(Math.floor(body.x), Math.floor(body.y - 0.2), 'dirt', 4);
      if (this.svc.settings().haptics) svc.vibrate(6);
    }
    this.playerImg.setPosition(body.x * TILE, body.y * TILE);
    this.shadowImg.setPosition(body.x * TILE, body.y * TILE - 1);
    // 离地越高投影越小越淡，落地那一刻"贴合"的反馈靠它
    const air = this.groundDistance();
    const k = clamp(1 - air / 96, 0.55, 1);
    this.shadowImg.setScale(k, k).setAlpha(0.34 * k);

    // 挖掘 / 放置
    if (this.inputState.dig) this.digTick(dt);
    else {
      this.digTarget = null;
      this.digProgress = 0;
      this.digAcc = 0;
      this.digStarted = false;
    }
    if (this.inputState.placePressed) {
      this.inputState.placePressed = false;
      this.tryPlace();
    }

    // 渲染
    this.updateAnim(dt, moveX);
    this.updateHeld();
    this.updateSelection();
    this.updateChunks();
    this.drawCrack();
    this.updateDarkness();
    this.updateParticles(dt);
    this.tickFps(deltaMs);
    this.lastLoopMs += deltaMs;
  }

  get progress(): number {
    return this.digTarget ? this.digProgress : 0;
  }

  /** 暗层是否因为低画质被关掉（低画质不画暗层，换取帧率） */
  get darkLayerVisible(): boolean {
    return this.darkness.visible;
  }

  /**
   * 暗层的重绘计数与"这一帧是否重绘"标记，只给自动化测试用。
   *
   * 为什么需要它：暗度是按 body.y 算的，而角色 teleport 之后还要下落几格，
   * 中间若干帧 amount 是 0.3~0.6 的过渡值；光等 onGround 也不够 —— 落地瞬间
   * 贴地校正会让 onGround 反复横跳。用例需要的是"暗层已经按最终位置画出来了"，
   * 而这个计数恰好就是这个事实的充分必要证据。
   */
  darkPass = 0;
  darkPainted = false;

  /**
   * 仅供自动化测试：临时关掉暗层，用来做"同一格有暗层 / 没暗层"的亮度对比。
   * 这比"岩壁比空洞亮"可靠得多 —— 后者受背景层与纹理抖动影响，本质是在测随机种子。
   */
  setDarkLayerForTest(on: boolean): void {
    this.darkness.setVisible(on);
  }

  consumeDirtyNotice(): boolean {
    const d = this.dirtyNotice;
    this.dirtyNotice = false;
    return d;
  }

  // ── 挖掘 ─────────────────────────────────────────────

  private aimTile(): { tx: number; ty: number } {
    const tx = Math.floor(this.body.x + this.body.facing * 0.9);
    const ty = Math.floor(this.body.y - 0.9);
    return { tx, ty };
  }

  /** 当前手持工具对某种方块的效率：工具对口才有等级加成 */
  toolPower(def: BlockDef): { speed: number; tier: number } {
    const held = toolById(this.inv.tools.held);
    if (def.tool === 'hand') return { speed: held ? 1.5 : 1, tier: 0 };
    if (held && held.kind === def.tool) return { speed: held.speed, tier: held.tier };
    const anyTier = toolTier(this.inv, def.tool);
    return { speed: 0.7, tier: Math.min(anyTier, 0) };
  }

  private digTick(dt: number) {
    const { world, svc } = this;
    const aim = this.aimTile();
    const id = world.getBlock(aim.tx, aim.ty);
    const def = blockById(id);
    if (id === AIR || def.hardness < 0) {
      this.digTarget = null;
      this.digProgress = 0;
      return;
    }
    if (!this.digTarget || this.digTarget.tx !== aim.tx || this.digTarget.ty !== aim.ty) {
      this.digTarget = { ...aim };
      this.digProgress = 0;
      this.digAcc = 0;
      this.digStarted = false;
    }
    const interval = clamp(this.svc.settings().digHoldMs, 120, 400) / 1000;
    const power = this.toolPower(def);
    const need = 0.3 + def.hardness * 0.34; // 达到 1.0 所需的"秒数"（按全速）

    this.digAcc += dt;
    if (!this.digStarted) {
      // 第一次按下的即时反馈（不扣耐久）
      this.digStarted = true;
      svc.sound.dig();
      this.burst(aim.tx, aim.ty, def.key, 1);
      this.digProgress += (0.06 * power.speed) / need;
      return;
    }
    while (this.digAcc >= interval) {
      this.digAcc -= interval;
      svc.sound.dig();
      this.burst(aim.tx, aim.ty, def.key, 2);
      this.digProgress += (interval * power.speed) / need;
      if (this.digProgress >= 1) {
        this.finishDig(aim.tx, aim.ty, id, power.tier);
        this.digProgress = 0;
        this.digAcc = 0;
        break;
      }
    }
  }

  private finishDig(tx: number, ty: number, id: number, tier: number) {
    const { world, inv, svc } = this;
    const def = blockById(id);
    if (tier < def.tier) {
      svc.sound.error();
      svc.toast(tier === 0 ? `需要一把${def.tier >= 2 ? '铜镐' : '石镐'}才能挖${def.name}` : `这里的${def.name}需要更好的镐`, 'warn');
      this.digProgress = 0;
      return;
    }
    const dropKey = def.drop ?? def.key;
    if (count(inv, dropKey) >= 999) {
      svc.toast(`${def.name} 已经 999 了`, 'warn');
      this.digProgress = 0;
      return;
    }
    world.setBlock(tx, ty, AIR);
    add(inv, dropKey, 1);
    autoHotbar(inv, dropKey);
    svc.sound.breakBlock();
    this.burst(tx, ty, dropKey, 8);
    if (svc.settings().haptics) svc.vibrate(10);

    const held = toolById(inv.tools.held);
    if (held && def.tool !== 'hand' && held.kind === def.tool) {
      if (wearTool(inv, held.id, 1)) {
        svc.sound.toolBreak();
        svc.toast(`${held.name} 磨损了`, 'warn');
      }
    }
    this.dropLoose(tx, ty, 0);
    this.markDirty(tx, ty);
    this.dirtyNotice = true;
    svc.requestUiSync();
  }

  /** 挖空后，上方悬空的方块往下掉一格（避免"空中楼阁"看起来像 bug） */
  private dropLoose(tx: number, ty: number, depth: number) {
    if (depth > 16) return;
    const above = this.world.getBlock(tx, ty - 1);
    if (above === AIR) return;
    const a = blockById(above);
    if (a.hardness < 0) return;
    if (this.world.getBlock(tx, ty) !== AIR) return;
    this.world.setBlock(tx, ty, above);
    this.world.setBlock(tx, ty - 1, AIR);
    this.markDirty(tx, ty);
    this.markDirty(tx, ty - 1);
    this.dropLoose(tx, ty - 1, depth + 1);
  }

  /** 方块变更：标记所在 chunk（及其相邻 chunk 用于边缘）需要重绘 */
  markDirty(tx: number, ty: number) {
    const cx = Math.floor(tx / CHUNK);
    const cy = Math.floor(ty / CHUNK);
    const lx = tx - cx * CHUNK;
    const ly = ty - cy * CHUNK;
    const keys = [`${cx},${cy}`];
    if (lx === 0) keys.push(`${cx - 1},${cy}`);
    if (lx === CHUNK - 1) keys.push(`${cx + 1},${cy}`);
    if (ly === 0) keys.push(`${cx},${cy - 1}`);
    if (ly === CHUNK - 1) keys.push(`${cx},${cy + 1}`);
    for (const k of keys) {
      const v = this.views.get(k);
      if (v) v.dirty = true;
    }
  }

  private tryPlace() {
    const { world, inv, body, svc } = this;
    const key = inv.hotbar[this.activeSlot];
    if (!key) {
      svc.sound.error();
      svc.toast('快捷栏这一格是空的', 'warn');
      return;
    }
    if (count(inv, key) <= 0) {
      svc.sound.error();
      svc.toast(`${blockByKey(key)?.name ?? key} 用完了`, 'warn');
      return;
    }
    const { tx, ty } = this.aimTile();
    if (!world.canPlace(tx, ty)) {
      svc.sound.error();
      return;
    }
    if (tileOverlapsBody(tx, ty, body)) {
      svc.sound.error();
      return;
    }
    remove(inv, key, 1);
    world.setBlock(tx, ty, blockByKey(key)!.id);
    svc.sound.place();
    this.burst(tx, ty, key, 3);
    this.markDirty(tx, ty);
    this.dirtyNotice = true;
    svc.requestUiSync();
  }

  // ── 质量 / 缩放 ──────────────────────────────────────

  applySettingsQuality() {
    const q = this.svc.settings().quality;
    this.quality = q === 'auto' ? this.quality : q;
    this.applyQuality();
  }

  private applyQuality() {
    this.viewCap = this.quality === 'low' ? VIEW_CAP_LOW : VIEW_CAP;
    this.darkness.setVisible(this.quality !== 'low');
    this.applyZoom();
  }

  /**
   * 暗部强度是否跟随深度变化。
   *
   * 「自动」档下这个开关是**关**的 —— 这是被实机截图逼出来的决定，不是审美问题：
   * 「自动」会按帧率从 high 掉到 mid，而 mid 我原来按"稍弱一点"设计，
   * 结果同一口矿洞，一台手机上漆黑一片、另一台手机上灰蒙蒙，
   * 玩家会以为是 bug（"为什么我朋友的地下能看清，我的全黑"）。
   * 现在只有「低画质」明确关掉暗层，high 与 mid 画面完全一致，不再有"看不清"的档位。
   * 属性保留给需要单独调节的场合（调试、E2E 断言）。
   */
  get depthDarkening(): boolean {
    return this.quality !== 'low';
  }

  private applyZoom() {
    const cam = this.cameras.main;
    const w = cam.width || this.scale.width;
    const h = cam.height || this.scale.height;
    // 目标：横向大约看见 26 格（416px），纵向至少 15 格
    const base = Math.min(w / 416, h / 240);
    const mult = this.quality === 'high' ? 1 : this.quality === 'mid' ? 1 : 1;
    // 像素风：优先整数倍，不足 1 时按 0.25 步进
    let z = base * mult;
    if (z >= 2) z = Math.floor(z);
    else z = Math.max(0.5, Math.round(z * 4) / 4);
    cam.setZoom(z);
  }

  // ── 渲染 ─────────────────────────────────────────────

  /**
   * 把 body 的位置**立刻**同步到贴图与相机。
   *
   * 平时靠 update() 每帧同步就够，但"传送"（重生 / 读档 / 调试）是一次性跳变：
   * 若只改 body，贴图要等下一帧才动，相机又在 lerp 追贴图 —— 中间那几帧
   * 相机世界矩形和玩家真实位置对不上，暗层光圈会画歪，玩家还会看到一段"飞行"。
   * 这里强制对齐一次，让跳变当场生效。
   */
  snapToBody(): void {
    const px = this.body.x * TILE;
    const py = this.body.y * TILE;
    this.playerImg.setPosition(px, py);
    this.shadowImg.setPosition(px, py - 1);
    this.cameras.main.centerOn(px, py);
  }

  private updateAnim(dt: number, moveX: number) {
    const b = this.body;
    if (!b.onGround) this.playerImg.setTexture('c_3');
    else if (Math.abs(moveX) > 0.1) {
      this.animT += dt;
      const dur = 0.13;
      if (this.animT > dur) {
        this.animT = 0;
        this.animFrame = this.animFrame === 1 ? 2 : 1;
      }
      this.playerImg.setTexture(`c_${this.animFrame}`);
    } else {
      this.animFrame = 0;
      this.playerImg.setTexture(this.inputState.dig ? 'c_4' : 'c_0');
    }
    this.playerImg.setFlipX(b.facing < 0);
  }

  /** 脚下到最近实心面的距离（px）。落地时为 0，用于投影缩放 */
  private groundDistance(): number {
    const b = this.body;
    if (b.onGround) return 0;
    const col = Math.floor(b.x);
    const start = Math.floor(b.y);
    for (let ty = start; ty < start + 8; ty++) {
      if (this.world.isSolid(col, ty)) return Math.max(0, (ty - b.y) * TILE);
    }
    return 96;
  }

  /** 手里显示当前工具；挥动时（挖掘中）前伸并轻微旋转 */
  private updateHeld() {
    const held = toolById(this.inv.tools.held);
    if (!held) {
      this.heldImg.setVisible(false);
      return;
    }
    const key = TEX.icon(held.kind);
    if (this.heldImg.texture.key !== key) this.heldImg.setTexture(key);
    const facing = this.body.facing;
    const swing = this.inputState.dig ? Math.sin(performance.now() / 70) * 0.5 : 0;
    this.heldImg
      .setVisible(true)
      .setPosition(this.body.x * TILE + facing * 6, this.body.y * TILE - 10 - (this.inputState.dig ? 1 : 0))
      .setFlipX(facing < 0)
      .setScale(0.5)
      .setRotation(facing * (0.5 + swing));
  }

  private updateSelection() {
    const aim = this.aimTile();
    const def = blockById(this.world.getBlock(aim.tx, aim.ty));
    const ok = def.id !== AIR && def.hardness >= 0;
    this.selectRect.setVisible(ok);
    if (ok) this.selectRect.setPosition(aim.tx * TILE + TILE / 2, aim.ty * TILE + TILE / 2);
  }

  private drawCrack() {
    const g = this.crack;
    g.clear();
    if (!this.digTarget || this.digProgress <= 0.03) return;
    const { tx, ty } = this.digTarget;
    const p = clamp(this.digProgress, 0, 1);
    const cx = tx * TILE + TILE / 2;
    const cy = ty * TILE + TILE / 2;
    g.lineStyle(1, 0x0e0b09, 0.8);
    const n = Math.ceil(p * 7);
    for (let i = 0; i < n; i++) {
      const a = (i / 7) * Math.PI * 2 + 0.4;
      const r1 = 1 + (i % 2) * 2;
      const r2 = 2 + p * 7;
      g.lineBetween(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1, cx + Math.cos(a) * r2, cy + Math.sin(a) * r2);
    }
    if (p > 0.6) {
      g.fillStyle(0x000000, (p - 0.6) * 0.5);
      g.fillRect(tx * TILE, ty * TILE, TILE, TILE);
    }
  }

  /**
   * 地下暗部。
   *
   * 踩过的坑：以前是「整个屏幕铺一层黑，再在玩家位置叠几圈橙色」——
   * 橙色只能提亮、不能"挖洞"，玩家周围始终被压黑，暗处根本看不清自己在挖什么。
   * 现在改成「把玩家周围从黑层里擦掉」：destination-out 径向渐变擦出一个软边圆，
   * 光晕才真正是"光"。火把只是把半径加大一点（有火把 = 看得更远）。
   */
  /**
   * 地下压暗强度 0~0.86。
   *
   * 阈值必须跟着**地形**走，不能拍脑袋写死数字。
   * 平地地表大约在 y≈77，山谷能低到 y≈86 —— 早先写成 70 起步，
   * 结果站在地表就有一层 0.2 的灰，白天看着像加了滤镜。
   * 现在以海平面（SEA_LEVEL）为基准：地表及浅处完全不压，
   * 从海平面下 4 格开始变暗，到海平面下 36 格达到 0.86（最深处的暗度）。
   *
   * 位置取脚下的地面高度（body.y 回落 1 格）而不是脚底本身：
   * 脚底永远贴着地面，用脚底会让"跳起来"的那一瞬间暗度跟着变，画面会呼吸。
   */
  get darknessAmount(): number {
    return clamp((this.body.y - 1 - (SEA_LEVEL + 4)) / 32, 0, 0.86);
  }

  /**
   * 手里举着东西时视野会变亮。
   *
   * 取「手持工具」**或**「快捷栏选中火把」—— 以前只认手持工具，
   * 于是"挖到火把、切到火把格"这件玩家以为在照明的事，其实什么都没发生。
   * 不单独做一次火光判定：那需要扫描范围内所有火把方块，代价在低端机上不值当。
   */
  private get litByTool(): boolean {
    if (toolById(this.inv.tools.held)) return true;
    const sel = this.inv.hotbar[this.activeSlot];
    return sel === 'torch' && count(this.inv, 'torch') > 0;
  }

  /**
   * 地下暗部。
   *
   * 这段是**纯观感**，反复改过四五版，把结论写在这里，免得下次又绕回去：
   *
   * ① 不能"整屏铺黑 + 玩家周围挖个洞"（火把光圈的思路）。
   *    横版剖面上，洞穴是"你想看清的墙"，岩层是"你想挖的东西"，两者是同一批像素；
   *    一个以玩家为中心的圆光只会把玩家脚边照亮，**自己要挖的那一格反而是黑的**。
   *    实机截图里的表现是"一束白光打在身上，洞穴看不清"，比不压暗还难受。
   *    所以光不能用点光源，得用"环境光衰减"：越深越暗，但暗得均匀。
   *
   * ② 空洞（空气）要比岩层更暗。
   *    这一条决定了"这是洞穴还是隧道"。只在岩层上叠加暗层，空气处只剩天空/背景色，
   *    两边的亮度差立刻把空间感交代清楚 —— 玩家一眼能看出"我在一条通道里"。
   *    实现上现在靠"暗层只盖岩层"：空洞处露出身后的背景，天然更深。
   *
   * ③ 挖的那一格必须有光照提醒。
   *    aim 高亮已经是金色描边，暗到 0.8 也还看得见，不需要额外的光斑。
   */
  private updateDarkness() {
    const g = this.darkness;
    this.darkPainted = false;
    if (!g.visible) return;
    const cam = this.cameras.main;
    const a = this.darknessAmount;
    g.clear();
    if (a <= 0.01) return;

    // 覆盖范围：**用 getWorldPoint 反查屏幕四角**，而不是读 worldView。
    //
    // 为什么不信 worldView：它是相机在 preRender 里算出来的缓存值，而 update()
    // 每帧跑在 preRender **之前** —— follow + lerp 的相机这时还在动，读到的是上一帧
    // （甚至上上帧）的矩形。表现就是：暗层比画面"慢半拍"，边缘露出没被压暗的一条。
    // getWorldPoint 是纯函数（不读缓存），屏幕四角换算出真实的世界矩形，永远对齐。
    const tl = cam.getWorldPoint(0, 0);
    const br = cam.getWorldPoint(cam.width, cam.height);
    const pad = 16; // 取整/亚像素余量
    const x0 = tl.x - pad;
    const y0 = tl.y - pad;
    const w = br.x - tl.x + pad * 2;
    const h = br.y - tl.y + pad * 2;

    // 底色：整屏压暗。这一层管的是"空气有多黑"。
    g.fillStyle(0x06060a, a);
    g.fillRect(x0, y0, w, h);
    this.darkPass++;
    this.darkPainted = true;

    // 手里举着光源时，玩家周围一圈的**空气**稍微透亮一点（看得见通道延伸的方向）。
    // 只在有光源时出现 —— 没火把的人不该有这层"透视"。
    const lit = this.litByTool;
    if (lit) {
      const cx = this.body.x * TILE;
      // 圆心抬到胸口：用脚底时，站在坑里往下挖会发现"两边亮、脚下黑"，
      // 而玩家最需要看清的恰恰是脚下和身前那一格。
      const cy = (this.body.y - 1.0) * TILE;
      const base = 48 + Math.min(56, Math.max(0, this.body.y - 76) * 0.35);
      const r = base * 1.45;
      // 用「由外向内叠擦」近似径向渐变（Graphics 没有原生渐变填充）。
      //
      // 两个都踩过的坑：
      //  ① 每圈用同一个 alpha → 相邻圈叠加后边缘跳变，看起来是一圈圈**同心环**。
      //  ② 按面积份额反解 alpha 再叠 22 圈 → 累积擦除趋近 1，圆圈变成**纯白实心**。
      // 正确做法：先定"半径 t 处希望累计擦掉多少"，再逐圈反解。
      // 擦除是乘性的（剩余 *= 1-α），所以必须递推 `prevRemain`，不能各圈独立算。
      g.setBlendMode(Phaser.BlendModes.ERASE);
      // 环数：14 圈时在暗底上仍能看出一圈圈的"阶梯"（亮度差越过 1 个 8bit 色阶）。
      // 28 圈把每圈步长压到 1 色阶以内，就成了连续的雾。
      const rings = 28;
      // 中心擦掉 0.8：核心区域在暗底上几乎回到原色，边缘再自然过渡到"全黑"。
      // 早先给到 0.9 时，擦得太干净、渐变又太陡，看起来像一盏聚光灯打在角色身上；
      // 现在半径放大、衰减放缓，读起来是"通道里有一点微光"。
      const core = 0.8;
      const erasedAt = (t: number) => {
        const u = 1 - t;
        // 线性为主（u），叠一点 smoothstep 让边缘更软。
        // 纯 smoothstep 会聚成亮斑，纯线性又会在外缘留一道硬边。
        return core * (0.62 * u + 0.38 * u * u * (3 - 2 * u));
      };
      for (let i = rings; i >= 1; i--) {
        const t = i / rings;
        const prevRemain = 1 - erasedAt((i + 1) / rings); // 外一圈擦完后还剩多少
        const nowRemain = 1 - erasedAt(t); // 这一圈擦完后想剩下多少
        if (nowRemain >= prevRemain) continue;
        const aRing = clamp(1 - nowRemain / prevRemain, 0, 0.98);
        g.fillStyle(0xffffff, aRing);
        g.fillCircle(cx, cy, r * t);
      }
      g.setBlendMode(Phaser.BlendModes.NORMAL);
      // 一抹暖色，避免"透出来的那一圈"看起来是冷灰色
      g.fillStyle(0xffb066, 0.04);
      g.fillCircle(cx, cy, r * 0.7);
    }
  }

  private redrawBackground() {
    const cam = this.cameras.main;
    const w = cam.width;
    const h = cam.height;
    const g = this.bg;
    g.clear();
    for (const lg of this.bgLayers) lg.destroy();
    this.bgLayers.length = 0;

    // 天空：由深蓝灰到暖褐的纵向渐变。分成 24 条 1px 左右的高带，
    // 每条重叠 1px，避免缩放后出现横向缝隙（这是纯色带最容易露馅的地方）。
    const top = Phaser.Display.Color.ValueToColor(0x161a24);
    const mid = Phaser.Display.Color.ValueToColor(0x2a2833);
    const low = Phaser.Display.Color.ValueToColor(0x4a3a34);
    const horizon = h * 0.62;
    const steps = 40;
    for (let i = 0; i < steps; i++) {
      const t = i / (steps - 1);
      const c = t < 0.5 ? Phaser.Display.Color.Interpolate.ColorWithColor(top, mid, 20, Math.round(t * 40)) : Phaser.Display.Color.Interpolate.ColorWithColor(mid, low, 20, Math.round((t - 0.5) * 40));
      g.fillStyle(Phaser.Display.Color.GetColor(c.r, c.g, c.b), 1);
      g.fillRect(0, (horizon * i) / steps - 1, w, horizon / steps + 2);
    }

    // 远景山脊：三层视差剪影。越远越接近天空色 —— 但必须比天空**暗**，
    // 否则在深蓝天上等于隐形。每层底部再压一道更暗的轮廓，模拟逆光的地脊线。
    const layers = [
      { sf: 0.05, color: 0x39405a, base: horizon * 0.72, amp: 30, freq: 0.006, seed: 11 },
      { sf: 0.09, color: 0x2b3145, base: horizon * 0.86, amp: 38, freq: 0.009, seed: 23 },
      { sf: 0.14, color: 0x1f2432, base: horizon * 1.0, amp: 24, freq: 0.014, seed: 37 },
    ];
    for (const L of layers) {
      const lg = this.add.graphics().setDepth(-19).setScrollFactor(L.sf);
      this.bgLayers.push(lg);
      const span = w * 3;
      const ridge = (x: number) =>
        L.base +
        (Math.sin(x * L.freq + L.seed) * 0.55 +
          Math.sin(x * L.freq * 2.3 + L.seed * 1.7) * 0.3 +
          Math.sin(x * L.freq * 5.1 + L.seed * 0.3) * 0.15) *
          L.amp;
      lg.fillStyle(L.color, 1);
      lg.beginPath();
      lg.moveTo(-span * 0.2, h);
      for (let x = -span * 0.2; x <= span * 0.6; x += 6) lg.lineTo(x, ridge(x));
      lg.lineTo(span * 0.6, h);
      lg.closePath();
      lg.fillPath();
      // 山脊高光：沿山脊线画一条 2px 的亮边，暗部才有"体积"
      lg.lineStyle(2, 0x6b7699, 0.28);
      lg.beginPath();
      for (let x = -span * 0.2; x <= span * 0.6; x += 6) {
        if (x === -span * 0.2) lg.moveTo(x, ridge(x));
        else lg.lineTo(x, ridge(x));
      }
      lg.strokePath();
    }

    // 地平线上的一层薄雾，让远山和地面衔接得不那么硬
    g.fillStyle(0x6b5a4a, 0.12);
    g.fillRect(0, horizon - 18, w, 26);
  }

  /**
   * 只渲染视口附近的 chunk；离屏的按 LRU 淘汰。
   *
   * 视野分两级：
   * - **活动层**（相机世界矩形 ±1 chunk）：正常绘制；
   * - **背景层**（再往外各扩 1 chunk）：降透明、禁混合，只用来把"世界左右边界"
   *   到"屏幕边缘"之间补满。没有它，走到贴着世界边界的地方，屏幕边上就是突兀的断口；
   *   用正常透明度它又会变成"另一堵墙"压在剖面上（见 styleFar 的注释）。
   */
  private updateChunks() {
    const cam = this.cameras.main;
    const wv = cam.worldView;
    const pxW = CHUNK * TILE;
    const x0 = Math.floor(wv.x / pxW) - 1;
    const x1 = Math.floor(wv.right / pxW) + 1;

    // ── 竖向范围必须按**屏幕实际高度**算，不能写死两行 ──
    //
    // 这里曾经写成 `y1 = y0 + 1`，注释理由是"竖屏只看得见 1~2 行 chunk"。
    // 在 844×390 的手机横屏下恰好成立，但换到桌面浏览器 / 平板 / 高分屏
    // （视口高度 500~1100px）就会露馅：两行 chunk 只有 64 格 = 1024 世界像素，
    // 视口一旦高于这个数，**下半屏就是空的** —— 表现为"地面凭空消失，人悬在半空"。
    // 现在按真实视口算出需要几行，再多留 1 行余量（相机 lerp / 震动时不会露边）。
    const rowH = pxW; // 1 个 chunk 在世界坐标里的高度（像素）
    // 用 cam.height 而不是 wv.height：zoom 恒为 1，两者数值相同，
    // 但 worldView 是 preRender 里算的缓存，update() 阶段可能还是上一帧的。
    const rows = Math.max(2, Math.ceil(cam.height / rowH) + 3);
    const y0 = Math.max(WORLD.cyMin, Math.floor(wv.y / rowH) - 1);
    const y1 = Math.min(WORLD.cyMax, y0 + rows - 1);
    const fx0 = x0 - 1;
    const fx1 = x1 + 1;
    const now = performance.now();

    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = fx0; cx <= fx1; cx++) {
        if (!this.world.inBounds(cx, cy)) continue;
        const core = cx >= x0 && cx <= x1;
        const key = `${cx},${cy}`;
        let v = this.views.get(key);
        if (!v) {
          if (this.world.isChunkEmpty(cx, cy)) continue;
          // 背景层不值得为它开一张新 canvas：只有已经存在的才升级成背景
          if (!core) continue;
          v = this.createView(cx, cy);
          this.views.set(key, v);
        } else if (v.dirty) {
          this.paintView(v);
        }
        this.styleFar(v, !core);
        v.lastUsed = now;
        v.image.setVisible(true);
      }
    }

    // 淘汰上限也必须跟着"实际需要的视图数"走。
    // 原来固定 24（低画质 14），是按"竖向 ≤2 行"估的：横屏 5 列 × 2 行 + 背景层 ≈ 18。
    // 竖向范围改成按屏幕高度算之后，桌面/平板可能要 4~5 行 × 7 列 ≈ 30+ 个视图，
    // 固定上限会把正在用的视图立刻淘汰重建 —— 表现为画面持续闪烁 + 帧率暴跌。
    const cap = Math.max(this.viewCap, (fx1 - fx0 + 1) * (y1 - y0 + 1) + 4);
    if (this.views.size > cap) {
      const arr = [...this.views.values()].filter((v) => v.cx < fx0 || v.cx > fx1 || v.cy < y0 || v.cy > y1);
      arr.sort((a, b) => a.lastUsed - b.lastUsed);
      const need = this.views.size - cap;
      for (let i = 0; i < Math.min(need, arr.length); i++) {
        const v = arr[i];
        this.textures.remove(this.textureKey(v));
        v.image.destroy();
        this.views.delete(v.key);
      }
    }
    for (const v of this.views.values()) {
      if (v.cx < fx0 || v.cx > fx1 || v.cy < y0 || v.cy > y1) v.image.setVisible(false);
      else v.image.setVisible(true);
    }
  }

  private textureKey(v: ChunkView): string {
    return `chunk_${v.cx}_${v.cy}`;
  }

  private createView(cx: number, cy: number): ChunkView {
    const canvas = document.createElement('canvas');
    canvas.width = CHUNK * TILE;
    canvas.height = CHUNK * TILE;
    const texKey = `chunk_${cx}_${cy}`;
    if (this.textures.exists(texKey)) this.textures.remove(texKey);
    this.textures.addCanvas(texKey, canvas);
    const image = this.add.image(cx * CHUNK * TILE, cy * CHUNK * TILE, texKey).setOrigin(0, 0).setDepth(1);
    const v: ChunkView = { key: `${cx},${cy}`, cx, cy, canvas, image, dirty: true, lastUsed: 0, far: false };
    this.paintView(v);
    return v;
  }

  /**
   * 把 chunk 标记为「视口外的背景层」。
   *
   * 为什么要分层：横版游戏的世界本质是一张剖面图，没有 3D 纵深。但相机的世界矩形
   * 通常比世界左右边界宽，两侧会拍到"世界之外"—— 如果不补背景，就是突兀的断口。
   * 旧做法是把相邻 chunk 也画出来补上断口，可那些 chunk 是从**侧面**（垂直于剖面）
   * 看过去的岩壁，跟脚下的剖面岩层长得一样，叠在同一屏里就成了
   * 「怎么有一层半透明的石头压在墙上」。远处那块必须是"看穿了"的岩层背景，
   * 不是另一堵墙。这里通过降透明度 + 禁混合模式来区分，让它明显退到后面。
   */
  private styleFar(v: ChunkView, far: boolean) {
    if (v.far === far) return;
    v.far = far;
    v.image.setAlpha(far ? 0.38 : 1);
    v.image.setBlendMode(far ? Phaser.BlendModes.MULTIPLY : Phaser.BlendModes.NORMAL);
  }

  private paintView(v: ChunkView) {
    const blocks = this.world.getChunk(v.cx, v.cy);
    if (!blocks) return;
    const ctx = v.canvas.getContext('2d')!;
    ctx.clearRect(0, 0, v.canvas.width, v.canvas.height);
    for (let iy = 0; iy < CHUNK; iy++) {
      for (let ix = 0; ix < CHUNK; ix++) {
        const id = blocks[iy * CHUNK + ix];
        if (id === AIR) continue;
        const key = blockById(id).key;
        const tile = this.tileCanvas.get(key);
        if (!tile) continue;
        ctx.drawImage(tile, ix * TILE, iy * TILE);
        // 方块顶部的接触阴影，让层次更清楚
        if (this.quality !== 'low' && this.isAir(blocks, ix, iy - 1)) {
          ctx.fillStyle = 'rgba(0,0,0,0.14)';
          ctx.fillRect(ix * TILE, iy * TILE, TILE, 2);
        }
      }
    }
    (v.image.texture.source[0] as Phaser.Textures.TextureSource).update();
    v.dirty = false;
  }

  private isAir(blocks: Uint8Array, ix: number, iy: number): boolean {
    if (iy < 0) return true;
    return blocks[iy * CHUNK + ix] === AIR;
  }

  /** 把纹理管理器的方块图块转成 canvas 引用（drawImage 最快） */
  prepareBlockTiles() {
    this.tileCanvas.clear();
    for (const key of this.textures.getTextureKeys()) {
      if (!key.startsWith('b_')) continue;
      const cv = this.textures.get(key).getSourceImage();
      if (cv instanceof HTMLCanvasElement) this.tileCanvas.set(key.slice(2), cv);
    }
    // 已存在的视图全部重绘（首次 prepare 时它们画的是空白）
    for (const v of this.views.values()) this.paintView(v);
  }

  private burst(tx: number, ty: number, blockKey: string, n: number) {
    if (this.quality === 'low') n = Math.min(n, 2);
    const tex = `b_${blockKey}`;
    for (let i = 0; i < n; i++) {
      const idx = this.pImg.findIndex((p) => !p.visible);
      if (idx < 0) return;
      const p = this.pImg[idx];
      const v = this.pVel[idx];
      p.setTexture(this.textures.exists(tex) ? tex : 'b_dirt');
      p.setPosition(tx * TILE + 3 + Math.random() * 10, ty * TILE + 3 + Math.random() * 10).setVisible(true).setAlpha(1);
      v.x = (Math.random() - 0.5) * 90;
      v.y = -30 - Math.random() * 90;
      v.life = 0.4 + Math.random() * 0.2;
    }
  }

  private updateParticles(dt: number) {
    for (let i = 0; i < this.pImg.length; i++) {
      const p = this.pImg[i];
      const v = this.pVel[i];
      if (!p.visible) continue;
      v.life -= dt;
      if (v.life <= 0) {
        p.setVisible(false);
        continue;
      }
      v.y += 340 * dt;
      p.x += v.x * dt;
      p.y += v.y * dt;
      p.setAlpha(Math.min(1, v.life * 2.4));
    }
  }

  private tickFps(deltaMs: number) {
    this.fpsBuf.push(deltaMs);
    if (this.fpsBuf.length < 30) return;
    const avg = this.fpsBuf.reduce((a, b) => a + b, 0) / this.fpsBuf.length;
    this.fpsBuf.length = 0;
    this.fps = Math.round(1000 / avg);
    if (this.svc.settings().quality !== 'auto') return;
    // 自动降档：连续多次 < 40fps 就降一级；回升到 55+ 才升（避免来回跳）
    if (this.fps < 40 && this.quality !== 'low') {
      if (++this.lowStreak >= 3) {
        this.quality = this.quality === 'high' ? 'mid' : 'low';
        this.lowStreak = 0;
        this.applyQuality();
        this.svc.toast(`帧率偏低，已自动降到「${this.quality === 'mid' ? '中' : '低'}」画质`);
      }
    } else if (this.fps > 57 && this.quality === 'mid') {
      this.lowStreak = Math.max(0, this.lowStreak - 1);
    } else {
      this.lowStreak = Math.max(0, this.lowStreak - 1);
    }
  }
}
