/**
 * 入口：启动顺序是
 *   读版本 → 开 IndexedDB → 读/建存档 → 竖屏闸门 → 建 Phaser → 绑触控 → PWA
 *
 * 原则：任何一步失败都不能白屏。数据库打不开就退化成"内存世界"（能玩，关掉就没了，并提示用户）。
 */
import Phaser from 'phaser';
import './ui/style.css';
import { buildBlockTextures } from './art/blocks';
import { buildToolIcons } from './art/character';
import { blockByKey } from './core/blocks';
import { CHUNK, TILE, WORLD } from './core/constants';
import { newMeta, importSave, makeSaveFile, encodeSave, type MetaState } from './core/save';
import { loadSettings, saveSettings, normalizeSettings, type Settings } from './core/settings';
import { seedFromText, seedToText, randomSeed } from './core/rng';
import { findSpawn, SEA_LEVEL } from './core/terrain';
import { add, autoHotbar, count } from './core/inventory';
import { RECIPES, type Recipe } from './core/recipes';
import { craft } from './core/inventory';
import { makeBody } from './core/physics';
import { GameScene } from './game/GameScene';
import { registerArt } from './game/artRuntime';
import { sound } from './game/audio';
import {
  canFullscreen,
  isPortrait,
  onStableViewport,
  readViewport,
  requestFullscreen,
  vibrate,
} from './game/viewport';
import { World } from './game/world';
import { SaveStore } from './persistence/idb';
import { exportSave, pickFile } from './persistence/transfer';
import { initPwa, loadVersion } from './pwa';
import { Ui } from './ui/ui';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// UI 层需要像素数据来画方块/工具图标（避免 UI 依赖 Phaser）
(window as any).__blockPixels = buildBlockTextures();
(window as any).__toolPixels = buildToolIcons();

let settings: Settings = loadSettings();
let store = new SaveStore();
let world: World;
let meta: MetaState;
let scene: GameScene | null = null;
let ui: Ui | null = null;
let activeSlot = 0;
let appMeta = { ver: '—', build: '—' };
let flushTimer = 0;
let lastSaveAt = 0;
let pendingFlush: Promise<void> | null = null;
let memoryOnly = false;

// ── 启动 ────────────────────────────────────────────────

async function boot() {
  const verP = loadVersion();
  applyOrientationGate();

  // 启动期间顺手请求锁横屏（Android Chromium 支持；iOS 不支持，靠闸门提示）
  try {
    (screen.orientation as any)?.lock?.('landscape')?.catch(() => {});
  } catch {
    /* ignore */
  }

  appMeta = await verP;

  try {
    await store.open();
  } catch (e) {
    memoryOnly = true;
    console.warn('IndexedDB 不可用，本次为临时存档', e);
  }

  let chunks = new Map<string, Uint8Array>();
  let loaded: MetaState | null = null;
  if (!memoryOnly) {
    try {
      loaded = await store.loadMeta();
      if (loaded) chunks = await store.loadChunks();
    } catch (e) {
      console.warn('读档失败，按新世界启动', e);
      loaded = null;
    }
  }

  if (loaded) {
    meta = loaded;
  } else {
    const seed = settings.lastSeed ? seedFromText(settings.lastSeed) : randomSeed();
    meta = newMeta(seed, findSpawn(seed));
    if (!memoryOnly) await store.saveMeta(meta).catch(() => {});
  }

  // 必须先建世界，ensureFreeSpot 要用它判可站立点
  world = new World(meta.seed, chunks);
  ensureFreeSpot();
  activeSlot = meta.player.active ?? 0;

  startGame();
  $('boot').hidden = true;
  $('ui').hidden = false;
  if (memoryOnly) {
    setTimeout(() => toast('浏览器不允许本地存储，本次进度关掉页面就没了', 'warn'), 800);
  } else if (settings.lastExport && Date.now() - Date.parse(settings.lastExport) > 7 * 86400000 && meta.player.playSec > 300) {
    setTimeout(() => toast('已经 7 天没导出备份了，建议去菜单导出一份', 'warn'), 2600);
  }

  void initPwa({
    getBuild: () => appMeta.build,
    banner: showBanner,
    hideBanner,
    beforeReload: flushAll,
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      scene?.setInput({ dig: false, moveX: 0 });
      void flushAll();
    }
  });
  window.addEventListener('pagehide', () => void flushAll());
  window.setInterval(() => {
    if (world.dirtyCount > 0) void flushAll();
  }, 8000);

  exposeDebug();
}

function applyOrientationGate() {
  const gate = $('orient-gate');
  const apply = (portrait: boolean) => {
    gate.hidden = !portrait;
  };
  apply(isPortrait());
  onStableViewport((v) => {
    apply(isPortrait(v));
    if (scene) scene.scale.resize(v.w, v.h);
  });
}

/**
 * 保证玩家站在一个"头顶有空间、脚下有地"的位置。
 *
 * 踩过的坑：以前从 meta.player.y 往上找空位，但存档里的 y 可能就是地表本身，
 * 于是循环第一次就判定"能站"并原样返回 —— 角色半个身子嵌在土里，
 * 相机的世界视口整体下沉近 3 行 chunk，画面下半屏直接变成空白。
 * 现在显式约定 **meta.player.y = 脚底所在格线**（即 body 的 y），
 * 站立要求：脚下第一格是实心，且身体下半格是空的。
 * 身体是 1.8 格高，判断时用 ty 与 ty-1 两格（取整后正好覆盖脚踝与膝盖）。
 * @returns 是否发生了纠正（调用方据此决定要不要提示）
 */
function ensureFreeSpot(): boolean {
  const { x } = meta.player;
  const fx = Math.floor(x);
  const start = Math.round(meta.player.y);
  let y = start;
  const standable = (yy: number) => !world.isSolid(fx, yy - 1) && world.isSolid(fx, yy);
  if (!standable(y)) {
    // 先下去：找到这一列最高的实心格子，站到它上面。
    // 搜索窗口别开太大 —— 窗口比"从上往下第一个实心格"还高的话，
    // 会先撞到下边界那排界石，人被塞到世界底部。
    const lo = Math.max(WORLD.cyMin * CHUNK, y - 160);
    const hi = Math.min((WORLD.cyMax + 1) * CHUNK, y + 280);
    let surface = -1;
    for (let ty = lo; ty < hi; ty++) {
      if (world.isSolid(fx, ty)) {
        surface = ty;
        break;
      }
    }
    if (surface > 0) y = surface;
    // 再上去：万一落点被塞住了（旧存档 / 地形改过），继续往上找
    let guard = 0;
    while (guard++ < 300 && !standable(y)) y -= 1;
  }
  meta.player.y = y;
  return y !== start;
}

// ── Phaser 与场景 ───────────────────────────────────────

function startGame() {
  const v = readViewport();
  const body = makeBody(meta.player.x, meta.player.y);

  ui = new Ui({
    onSlot: (i) => setSlot(i),
    onPickBlock: (key) => pickBlock(key),
    onCraft: (r) => doCraft(r),
    onOpenPanel: (k) => openPanel(k),
    onClosePanel: () => openPanel('none'),
    onExport: () => void doExport(),
    onImport: () => void doImport(),
    onNewWorld: () => void doNewWorld(),
    onSetting: (k, val) => {
      if (k === '__fullscreen') void requestFullscreen();
      else applySetting(k, val);
    },
  });
  ui.setFpsVisible(settings.showFps);
  ui.setHotbarActive(activeSlot);
  ui.bindKeyboard(() => openPanel(ui!.panel === 'bag' ? 'none' : 'bag'));

  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: 'game',
    width: v.w,
    height: v.h,
    backgroundColor: '#1b1614',
    pixelArt: true,
    roundPixels: true,
    antialias: false,
    scale: { mode: Phaser.Scale.NONE, width: v.w, height: v.h },
    render: { antialias: false, powerPreference: 'high-performance' },
    audio: { noAudio: true },
    banner: false,
  });
  (window as any).__phaser = game;

  const svc = {
    settings: () => settings,
    sound,
    vibrate,
    toast,
    requestUiSync: () => syncUi(true),
    onDirty: () => scheduleFlush(),
    onDepth: (d: number) => {
      if (d > meta.deepest) meta.deepest = d;
    },
    setActiveSlot: (i: number) => setSlot(i),
  };

  // 先生成纹理，再建场景（场景 create 里就要用 'c_0'）
  game.events.once(Phaser.Core.Events.READY, () => {
    registerArt(game.scene.getScene('game') as Phaser.Scene);
  });
  const s = new GameScene();
  game.scene.add('game', s, true, { world, inv: meta.inv, body, svc, activeSlot });
  scene = s;

  // 等场景真正 create 完
  const waitCreate = () => {
    // 等场景 create 完成且纹理注册好（registerArt 在 READY 事件里跑）
    if (s.sys && s.sys.isActive() && s.textures && s.textures.exists('c_0')) {
      s.prepareBlockTiles();
      s.applySettingsQuality();
      syncUi(true);
      bindTouch();
      if (!canFullscreen()) $('btn-fullscreen')?.setAttribute('hidden', '');
      requestAnimationFrame(frameLoop);
    } else {
      requestAnimationFrame(waitCreate);
    }
  };
  requestAnimationFrame(waitCreate);

}

/** 触控桥：摇杆与按钮 → 场景输入 */
function bindTouch() {
  ui!.bindTouch({
    setMove: (x) => scene?.setInput({ moveX: x }),
    setJump: (down) => down && scene?.setInput({ jump: true }),
    setDig: (down) => scene?.setInput({ dig: down }),
    place: () => scene?.setInput({ placePressed: true }),
    onFirstGesture: () => {
      sound.unlock();
      sound.setVolume(settings.vol);
      sound.setEnabled(settings.sfx);
    },
  });
  const once = () => sound.unlock();
  window.addEventListener('pointerdown', once, { once: true });
}

// ── 帧循环：UI 刷新统一从这里推 ─────────────────────────

function frameLoop() {
  requestAnimationFrame(frameLoop);
  if (!scene || !meta || !ui) return;
  if (uiNeedsSync) {
    uiNeedsSync = false;
    ui.sync(meta.inv, seedToText(meta.seed));
  }
  ui.setFps(scene.fps);
  ui.setProgress(scene.progress);
  if (scene.consumeDirtyNotice()) {
    /* 世界已变，UI 在上面的 sync 里已刷新 */
  }
}

let uiNeedsSync = true;
function syncUi(force = false) {
  if (force) uiNeedsSync = true;
}

// ── 操作 ────────────────────────────────────────────────

function setSlot(i: number) {
  activeSlot = i;
  meta.player.active = i;
  if (scene) scene.activeSlot = i;
  ui?.setHotbarActive(i);
  sound.tick();
}

function pickBlock(key: string) {
  const hb = meta.inv.hotbar;
  const at = hb.indexOf(key);
  if (at >= 0) setSlot(at);
  else {
    const empty = hb.indexOf(null);
    const slot = empty >= 0 ? empty : activeSlot;
    hb[slot] = key;
    setSlot(slot);
  }
  syncUi(true);
  openPanel('bag');
  scheduleFlush();
}

function doCraft(r: Recipe) {
  const res = craft(meta.inv, r);
  if (!res.ok) {
    sound.error();
    toast(res.code === 'MISSING' ? '材料不够' : res.code === 'FULL' ? '这种方块已经 999 了' : '无法合成', 'warn');
    return;
  }
  sound.craft();
  vibrate(12);
  const name = res.isTool ? r.tool! : blockByKey(res.out)?.name ?? res.out;
  toast(`合成了 ${name}${res.n > 1 ? ` ×${res.n}` : ''}`);
  syncUi(true);
  if (ui?.panel === 'craft') openPanel('craft');
  scheduleFlush();
}

// ── 面板 ────────────────────────────────────────────────

export function openPanel(kind: 'none' | 'bag' | 'craft' | 'menu') {
  if (!ui) return;
  if (kind === 'none') {
    ui.openPanel('none');
    return;
  }
  ui.openPanel(kind, {
    settings,
    ver: appMeta.ver,
    build: appMeta.build,
    seedText: seedToText(meta.seed),
    playSec: meta.player.playSec,
    chunks: world ? world.allEdits().size : 0,
    quality: scene ? scene.quality : '-',
  });
}

function applySetting(key: string, value: unknown) {
  settings = normalizeSettings({ ...settings, [key]: value });
  saveSettings(settings);
  if (key === 'vol') sound.setVolume(settings.vol);
  if (key === 'sfx') sound.setEnabled(settings.sfx);
  if (key === 'showFps') ui?.setFpsVisible(settings.showFps);
  if (key === 'quality') scene?.applySettingsQuality();
  if (ui && ui.panel !== 'none') openPanel(ui.panel);
  syncUi(true);
}

// ── 存档 ────────────────────────────────────────────────

function scheduleFlush() {
  window.clearTimeout(flushTimer);
  flushTimer = window.setTimeout(() => void flushAll(), 700);
}

/** 强制落盘。切后台 / 导出 / 刷新前都必须调 —— 移动端最容易丢档的就是这几个窗口。 */
async function flushAll(): Promise<void> {
  if (!world || !meta) return;
  if (pendingFlush) {
    await pendingFlush.catch(() => {});
  }
  if (scene) {
    meta.player.x = scene.body.x;
    meta.player.y = scene.body.y;
    meta.player.facing = scene.body.facing;
    meta.player.active = activeSlot;
    meta.player.playSec = Math.round(meta.player.playSec + (scene.lastLoopMs ?? 0));
    scene.lastLoopMs = 0;
  }
  if (memoryOnly) return;
  const edits = world.dirtyEdits();
  const keys = edits.map((e) => e.key);
  const snap = JSON.parse(JSON.stringify(meta));
  pendingFlush = (async () => {
    try {
      if (edits.length) await store.saveChunks(edits);
      world.ack(keys);
      await store.saveMeta(snap);
      lastSaveAt = Date.now();
    } catch (e) {
      console.warn('存档写入失败', e);
    } finally {
      pendingFlush = null;
    }
  })();
  await pendingFlush;
}

async function doExport() {
  await flushAll();
  const save = makeSaveFile(meta, world.allEdits(), appMeta.ver);
  const text = encodeSave(save);
  const res = await exportSave(text);
  settings.lastExport = new Date().toISOString();
  saveSettings(settings);
  if (res.method === 'share') toast('已打开系统分享面板：选「存储到文件」或发给自己');
  else if (res.method === 'clipboard') toast('存档已复制到剪贴板，粘贴到聊天窗口保存');
  else toast('已尝试下载；没反应就用下面这段文字手动复制', 'warn');
  if (res.method === 'download' || !res.text) showTextModal('备份存档', '长按全选 → 复制。粘到备忘录里就是一份备份。', text);
  else showTextModal('备份完成', '存档已经交到你手上了。再给一份文本备份，多一份安心。', text);
}

async function doImport() {
  let text = await pickFile();
  if (!text) {
    text = await promptTextModal(
      '粘贴存档',
      '把导出的存档文本粘在这里。也可以先点「选择文件」挑一个导出的 .json。',
      '',
      '选择文件',
      async () => {
        const t = await pickFile();
        if (t) {
          const ta = document.getElementById('m-text') as HTMLTextAreaElement | null;
          if (ta) ta.value = t;
        }
      },
    );
  }
  if (!text || !text.trim()) return;
  const res = importSave(text);
  if (!res.ok) {
    sound.error();
    toast(importError(res.error.code, res.error.detail), 'warn');
    return;
  }
  const m = res.save.meta;
  const ok = await confirmModal(
    '导入这个存档？',
    `种子 ${seedToText(m.seed)}\n已游玩 ${Math.floor(m.player.playSec / 60)} 分钟 · ${res.chunks.size} 个改动过的区块\n\n当前世界会被覆盖（原进度会在数据库备份里留一份）。`,
  );
  if (!ok) return;
  await flushAll();
  try {
    await store.replaceWorld(m, res.chunks);
  } catch (e) {
    toast(`导入失败：${(e as Error).message}`, 'warn');
    return;
  }
  toast('导入成功，正在重新载入…');
  setTimeout(() => location.reload(), 500);
}

async function doNewWorld() {
  const seedText = await promptTextModal(
    '开一个新世界',
    '留空 = 随机种子。同一个种子永远长出同一片地脉，可以抄给朋友。当前世界会被覆盖。',
    settings.lastSeed,
  );
  if (seedText === null) return;
  const seed = seedText.trim() ? seedFromText(seedText) : randomSeed();
  settings.lastSeed = seedToText(seed);
  saveSettings(settings);
  if (memoryOnly) {
    location.reload();
    return;
  }
  await flushAll().catch(() => {});
  const m = newMeta(seed, findSpawn(seed));
  try {
    await store.replaceWorld(m, new Map());
  } catch (e) {
    toast(`创建失败：${(e as Error).message}`, 'warn');
    return;
  }
  location.reload();
}

function importError(code: string, detail: string): string {
  const map: Record<string, string> = {
    NOT_JSON: '这段内容不是完整的存档（可能只复制了一半）',
    NOT_EARTHENO: '这不是《地髓》的存档',
    FMT_TOO_NEW: detail,
    BAD_CHUNK: `存档有一个区块损坏：${detail}`,
    BAD_META: `存档缺少世界信息：${detail}`,
  };
  return map[code] ?? `存档不完整：${detail}`;
}

function importErrorOld(code: string, detail: string): string {
  switch (code) {
    case 'NOT_JSON':
      return '这段内容不是完整的存档（可能只复制了一半）';
    case 'NOT_EARTHENO':
      return '这不是《地髓》的存档';
    case 'FMT_TOO_NEW':
      return detail;
    case 'BAD_CHUNK':
      return `存档有一个区块损坏：${detail}`;
    default:
      return `存档不完整：${detail}`;
  }
}

// ── 通用弹窗 ────────────────────────────────────────────

function modalShell(html: string): { root: HTMLElement; close: () => void } {
  const sheet = $('sheet');
  const wrap = document.createElement('div');
  wrap.className = 'panel';
  wrap.style.maxWidth = '560px';
  wrap.innerHTML = html;
  sheet.innerHTML = '';
  sheet.hidden = false;
  sheet.append(wrap);
  const close = () => {
    sheet.hidden = true;
    sheet.innerHTML = '';
  };
  wrap.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
  return { root: wrap, close };
}

function showTextModal(title: string, hint: string, text: string) {
  const { root, close } = modalShell(`
    <div class="panel__head"><div class="panel__title">${title}</div>
      <button class="iconbtn panel__close" data-close aria-label="关闭">✕</button></div>
    <div class="panel__body">
      <div class="hint">${hint}</div>
      <textarea id="m-text" readonly></textarea>
    </div>
    <div class="panel__foot">
      <button class="btn btn--primary touch" id="m-copy">全选并复制</button>
      <button class="btn touch" data-close>完成</button>
    </div>`);
  const ta = root.querySelector('#m-text') as HTMLTextAreaElement;
  ta.value = text;
  root.querySelector('#m-copy')!.addEventListener('click', async () => {
    ta.focus();
    ta.select();
    try {
      await navigator.clipboard.writeText(text);
      toast('已复制');
    } catch {
      toast('已全选，长按复制', 'warn');
    }
  });
  void close;
}

function promptTextModal(
  title: string,
  hint: string,
  initial = '',
  extraLabel?: string,
  onExtra?: () => void,
): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false;
    const { root, close } = modalShell(`
      <div class="panel__head"><div class="panel__title">${title}</div>
        <button class="iconbtn panel__close" data-close aria-label="取消">✕</button></div>
      <div class="panel__body">
        <div class="hint">${hint}</div>
        <textarea id="m-text" style="height:110px;margin-top:8px"></textarea>
      </div>
      <div class="panel__foot">
        ${extraLabel ? `<button class="btn touch" id="m-extra">${extraLabel}</button>` : ''}
        <button class="btn btn--primary touch" id="m-ok">确定</button>
        <button class="btn touch" data-close>取消</button>
      </div>`);
    const ta = root.querySelector('#m-text') as HTMLTextAreaElement;
    ta.value = initial;
    root.querySelector('#m-ok')!.addEventListener('click', () => {
      done = true;
      const v = ta.value;
      close();
      resolve(v);
    });
    if (extraLabel) root.querySelector('#m-extra')!.addEventListener('click', () => onExtra?.());
    root.querySelectorAll('[data-close]').forEach((b) =>
      b.addEventListener('click', () => {
        if (!done) resolve(null);
        done = true;
      }),
    );
    setTimeout(() => ta.focus(), 50);
  });
}

function confirmModal(title: string, body: string): Promise<boolean> {
  return new Promise((resolve) => {
    const { root, close } = modalShell(`
      <div class="panel__head"><div class="panel__title">${title}</div></div>
      <div class="panel__body"><div class="hint" style="white-space:pre-wrap">${body}</div></div>
      <div class="panel__foot">
        <button class="btn btn--primary touch" id="m-ok">确定</button>
        <button class="btn touch" data-close>取消</button>
      </div>`);
    root.querySelector('#m-ok')!.addEventListener('click', () => {
      close();
      resolve(true);
    });
    root.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => resolve(false)));
  });
}

// ── toast / banner ──────────────────────────────────────

function toast(msg: string, kind: 'ok' | 'warn' = 'ok') {
  ui?.toast(msg, kind);
}

function showBanner(
  msg: string,
  actionLabel?: string,
  onAction?: () => void,
  opts?: { sticky?: boolean; kind?: 'info' | 'off' },
) {
  const b = $('banner');
  b.className = `banner${opts?.kind === 'off' ? ' banner--off' : ''}`;
  b.innerHTML = '';
  const span = document.createElement('span');
  span.textContent = msg;
  b.append(span);
  if (actionLabel && onAction) {
    const btn = document.createElement('button');
    btn.className = 'btn touch';
    btn.textContent = actionLabel;
    btn.addEventListener('click', onAction);
    b.append(btn);
  }
  if (!opts?.sticky) {
    const x = document.createElement('button');
    x.className = 'btn touch';
    x.textContent = '知道了';
    x.addEventListener('click', () => (b.hidden = true));
    b.append(x);
  }
  b.hidden = false;
}
function hideBanner(kind?: 'info' | 'off') {
  const b = $('banner');
  if (!kind || (kind === 'off' && b.classList.contains('banner--off'))) b.hidden = true;
}

// ── 调试接口（E2E 与开发者工具用） ─────────────────────────

function exposeDebug() {
  (window as any).__eartheno = {
    version: appMeta,
    meta: () => meta,
    world: () => world,
    scene: () => scene,
    settings: () => settings,
    flush: () => flushAll(),
    openPanel: (k: string) => openPanel(k as any),
    teleport: (x: number, y: number) => {
      if (!scene) return;
      scene.body.x = x;
      scene.body.y = y;
      scene.body.vx = 0;
      scene.body.vy = 0;
      // 贴图与相机一并对齐，否则传送后会有几帧"贴图还在原处、相机在追"的错位
      scene.snapToBody();
    },
    give: (key: string, n = 1) => {
      add(meta.inv, key, n);
      // 必须和真实玩法一致：挖到 / 合成新材料都会自动上架快捷栏。
      // 漏这一步的话，测试里 give() 之后快捷栏还是空的，
      // 会误判成"上架逻辑坏了"。
      autoHotbar(meta.inv, key);
      syncUi(true);
    },
    blockAt: (x: number, y: number) => world.getBlock(x, y),
    setInput: (p: { moveX?: number; dig?: boolean; jump?: boolean; placePressed?: boolean }) => {
      scene?.setInput(p);
    },
    player: () => (scene ? { x: scene.body.x, y: scene.body.y, onGround: scene.body.onGround, facing: scene.body.facing } : null),
    aim: () => (scene ? { x: Math.floor(scene.body.x + scene.body.facing * 0.9), y: Math.floor(scene.body.y - 0.9) } : null),
    memoryOnly,

    // ── 以下仅供自动化测试驱动，UI 不依赖它们 ──
    /** 背包里某种方块的数量 */
    count: (key: string) => count(meta.inv, key),
    /** 当前手持工具 id（无工具为 null） */
    held: () => meta.inv.tools.held,
    /** 挖掘进度 0~1（是否在"长按连挖"的中间态） */
    digProgress: () => (scene ? scene.progress : 0),
    /** 画面内方块顶点对应的屏幕坐标，供触控用例点准目标格 */
    screenOf: (tx: number, ty: number) => {
      if (!scene) return null;
      const cam = scene.cameras.main;
      return {
        x: (tx * TILE - cam.worldView.x) * cam.zoom,
        y: (ty * TILE - cam.worldView.y) * cam.zoom,
      };
    },
    /**
     * 地下暗层的当前状态，供视觉回归用例断言。
     * 只暴露"看一眼就知道对不对"的量：当前压暗强度、光圈圆心是否落在屏幕内。
     * 这两条正好对应历史 bug：地表被误压暗 / 光圈画到屏幕外导致全黑。
     */
    darkness: () => {
      if (!scene) return null;
      const cam = scene.cameras.main;
      const tl = cam.getWorldPoint(0, 0);
      const br = cam.getWorldPoint(cam.width, cam.height);
      const zoom = cam.zoom;
      const cx = (scene.body.x * TILE - tl.x) * zoom;
      const cy = (scene.body.y * TILE - tl.y) * zoom;
      return {
        /** 压暗强度 0~0.86，0 表示完全不压 */
        amount: Math.min(0.86, Math.max(0, (scene.body.y - (SEA_LEVEL + 4)) / 32)),
        /** 光圈圆心在屏幕上的位置（应落在画布内） */
        center: { x: cx, y: cy },
        canvas: { w: cam.width, h: cam.height },
        visible: scene.darkLayerVisible,
      };
    },
    /** 强制存档落库（等价于切后台） */
    save: async () => {
      await flushAll();
    },
    /** 走一遍导出流程（浏览器里会触发下载/分享） */
    exportSave: () => doExport(),
    /** 直接拿到可导出的存档文本，避免测试点文件选择器 */
    exportText: async () => {
      await flushAll();
      return encodeSave(makeSaveFile(meta, world.allEdits(), appMeta.ver));
    },
    /** 用存档文本覆盖当前世界（成功后自动 reload，与真实导入一致） */
    importText: async (text: string) => {
      const res = importSave(text);
      if (!res.ok) return { ok: false as const, error: res.error.code };
      await flushAll();
      await store.replaceWorld(res.save.meta, res.chunks);
      return { ok: true as const, seed: res.save.meta.seed, chunks: res.chunks.size };
    },
    /** 合成（走真实 craft 通路） */
    craft: (id: string) => {
      const r = RECIPES.find((x) => x.id === id);
      if (!r) return { ok: false as const, code: 'NO_RECIPE' };
      const res = craft(meta.inv, r);
      syncUi(true);
      return res.ok ? { ok: true as const, out: res.out, n: res.n } : { ok: false as const, code: res.code };
    },
    /** 当前面板：'none' | 'bag' | 'craft' | 'set' */
    panel: () => ui?.panel ?? 'none',
  };
}

// ── go ──────────────────────────────────────────────────

boot().catch((e) => {
  console.error(e);
  $('boot-text').textContent = `启动失败：${(e as Error).message}`;
});
void Phaser;
void requestFullscreen;
