/**
 * UI 层：纯 DOM。
 *
 * 为什么不用 Phaser 画 UI：
 * ① 「窄屏溢出要用脚本量」的检查方式对 DOM 直接适用（经验文档 §8），canvas 里的 UI 量不出来；
 * ② 按钮最小尺寸、安全区、>16px 输入框这些无障碍要求，用 CSS 表达最稳；
 * ③ UI 与游戏解耦，把 UI 整段删掉，游戏本身依然能跑。
 *
 * 纪律：UI 只读数据 + 回调，不直接改世界；世界变更由 main 的帧循环统一调 sync()。
 */
import { BLOCKS, blockByKey } from '../core/blocks';
import { HOTBAR_SIZE, type InventoryData } from '../core/inventory';
import { RECIPES, toolById, type Recipe } from '../core/recipes';
import { fmtDate, fmtDuration, clamp } from '../core/util';

export type PanelKind = 'none' | 'bag' | 'craft' | 'menu';

export interface PanelExtra {
  settings: Record<string, any>;
  ver: string;
  build: string;
  seedText: string;
  playSec: number;
  chunks: number;
  quality: string;
}

export interface UiHandlers {
  onSlot(i: number): void;
  onPickBlock(key: string): void;
  onCraft(r: Recipe): void;
  onOpenPanel(k: PanelKind): void;
  onClosePanel(): void;
  onExport(): void;
  onImport(): void;
  onNewWorld(): void;
  onSaveNow(): void;
  onSetting(key: string, value: unknown): void;
}

export interface TouchApi {
  setMove(x: number): void;
  setJump(down: boolean): void;
  setDig(down: boolean): void;
  place(): void;
  onFirstGesture(): void;
}

const ICONS = {
  bag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 8h16l-1.5 12h-13z"/><path d="M8 8V6a4 4 0 0 1 8 0v2"/></svg>',
  jump: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 19V6M6 11l6-6 6 6"/></svg>',
  dig: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 21l6-6"/><path d="M9.5 8.5l5-5 6 6-5 5z"/></svg>',
  place: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M12 8v8M8 12h8"/></svg>',
  menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
  full: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
  save: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 4h11l3 3v13H5z"/><path d="M8 4v6h7V4M8 14h8v6H8z"/></svg>',
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, html?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

// ── 图标（用离屏 canvas 从像素数据生成 dataURL，一次缓存） ──

const iconCache = new Map<string, string>();
function pxToDataUrl(px: Uint8ClampedArray, w: number, h: number): string {
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  cv.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(px), w, h), 0, 0);
  return cv.toDataURL();
}

export function blockIcon(key: string): string {
  const hit = iconCache.get(`b:${key}`);
  if (hit) return hit;
  const px = (window as any).__blockPixels?.get(key) as Uint8ClampedArray | undefined;
  const url = px ? pxToDataUrl(px, 16, 16) : '';
  iconCache.set(`b:${key}`, url);
  return url;
}

function toolIcon(kind: string): string {
  const hit = iconCache.get(`t:${kind}`);
  if (hit) return hit;
  const p = (window as any).__toolPixels?.[kind] as { w: number; h: number; data: Uint8ClampedArray } | undefined;
  const url = p ? pxToDataUrl(p.data, p.w, p.h) : blockIcon('stone');
  iconCache.set(`t:${kind}`, url);
  return url;
}

function itemIcon(item: string): string {
  return blockByKey(item) ? blockIcon(item) : toolIcon(toolById(item)?.kind ?? 'pick');
}

function itemName(item: string): string {
  return blockByKey(item)?.name ?? toolById(item)?.name ?? item;
}

// ── Ui ─────────────────────────────────────────────────

export class Ui {
  private root: HTMLElement;
  private hotbarEl!: HTMLElement;
  private seedEl!: HTMLElement;
  private progressEl!: HTMLElement;
  private progressFill!: HTMLElement;
  private fpsEl: HTMLElement;
  private toastEl: HTMLElement;
  private sheet: HTMLElement;
  private saveEl!: HTMLElement;
  /** 上次写进顶栏文案的内容，避免每帧改 DOM */
  private saveSig = '\u0000';
  panel: PanelKind = 'none';
  private activeSlot = 0;
  private inv: InventoryData | null = null;
  private hotbarSig = '';
  private toastTimer = 0;
  private lastExtra: PanelExtra | null = null;

  constructor(private h: UiHandlers) {
    this.root = document.getElementById('ui')!;
    this.fpsEl = document.getElementById('fps')!;
    this.toastEl = document.getElementById('toast')!;
    this.sheet = document.getElementById('sheet')!;
    this.build();
  }

  private build() {
    const top = el('div', 'topbar');
    top.innerHTML = `<div class="topbar__title">地髓</div><div class="topbar__seed" id="seedline"></div><div class="topbar__spacer"></div>`;

    const iconBtn = (id: string, label: string, html: string, fn: () => void) => {
      const b = el('button', 'iconbtn touch', html);
      b.id = id;
      b.title = label;
      b.setAttribute('aria-label', label);
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        fn();
      });
      return b;
    };
    top.append(iconBtn('btn-save', '立即保存', ICONS.save, () => this.h.onSaveNow()));
    top.append(iconBtn('btn-fullscreen', '全屏 / 横屏', ICONS.full, () => this.h.onSetting('__fullscreen', true)));
    top.append(iconBtn('btn-menu', '菜单', ICONS.menu, () => this.h.onOpenPanel('menu')));
    this.root.append(top);
    this.seedEl = top.querySelector('#seedline')!;

    // 顶栏正中的"待保存"提示：让保存状态可见，而不是只存在于玩家的想象里
    this.saveEl = el('div', 'topbar__status');
    this.saveEl.id = 'savestate';
    this.saveEl.hidden = true;
    top.append(this.saveEl);

    // 摇杆
    const joy = el('div', 'joystick touch');
    joy.id = 'joystick';
    const knob = el('div', 'joystick__knob');
    knob.id = 'joy-knob';
    joy.append(knob, el('div', 'joystick__hint', '按住拖动'));
    this.root.append(joy);

    // 动作键 2×2：左上背包、右上跳、左下挖、右下放
    const acts = el('div', 'actions');
    const abtn = (cls: string, id: string, label: string, html: string) => {
      const b = el('button', `abtn touch ${cls}`, html);
      b.id = id;
      b.title = label;
      b.setAttribute('aria-label', label);
      return b;
    };
    acts.append(
      abtn('abtn--bag', 'btn-bag', '背包（E）', ICONS.bag),
      abtn('abtn--jump', 'btn-jump', '跳跃（空格）', ICONS.jump),
      abtn('abtn--dig', 'btn-dig', '挖掘（按住连续挖）', ICONS.dig),
      abtn('abtn--place', 'btn-place', '放置（X）', ICONS.place),
    );
    this.root.append(acts);
    acts.querySelector('#btn-bag')!.addEventListener('click', () => this.h.onOpenPanel(this.panel === 'bag' ? 'none' : 'bag'));

    // 快捷栏
    this.hotbarEl = el('div', 'hotbar touch');
    this.hotbarEl.id = 'hotbar';
    this.root.append(this.hotbarEl);

    // 挖掘进度条
    this.progressEl = el('div', 'progress');
    this.progressEl.id = 'progress';
    this.progressFill = el('div', 'progress__fill');
    this.progressEl.append(this.progressFill);
    this.root.append(this.progressEl);
  }

  /** 触控绑定：Pointer Events 按 pointerId 分流，摇杆与按钮可以同时按 */
  bindTouch(api: TouchApi) {
    const joy = document.getElementById('joystick')!;
    const knob = document.getElementById('joy-knob')!;
    let joyId: number | null = null;
    let cx = 0;
    let cy = 0;
    const R = 44;

    const apply = (ev: PointerEvent) => {
      const dx = ev.clientX - cx;
      const dy = ev.clientY - cy;
      const d = Math.hypot(dx, dy) || 1;
      const k = Math.min(1, R / d);
      const kx = dx * k;
      const ky = dy * k;
      knob.style.transform = `translate(${kx}px, ${ky}px)`;
      const nx = kx / R;
      api.setMove(Math.abs(nx) < 0.15 ? 0 : clamp(nx * 1.3, -1, 1));
    };

    joy.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      api.onFirstGesture();
      joyId = ev.pointerId;
      const r = joy.getBoundingClientRect();
      cx = r.left + r.width / 2;
      cy = r.top + r.height / 2;
      // 拇指按在边缘也能用：把锚点挪到手指附近
      const ox = ev.clientX - cx;
      const oy = ev.clientY - cy;
      const od = Math.hypot(ox, oy);
      if (od > R * 0.7) {
        cx = ev.clientX - (ox / od) * R * 0.4;
        cy = ev.clientY - (oy / od) * R * 0.4;
      }
      try {
        joy.setPointerCapture(ev.pointerId);
      } catch {
        /* ignore */
      }
      apply(ev);
    });
    joy.addEventListener('pointermove', (ev) => {
      if (ev.pointerId !== joyId) return;
      ev.preventDefault();
      apply(ev);
    });
    const end = (ev: PointerEvent) => {
      if (ev.pointerId !== joyId) return;
      joyId = null;
      knob.style.transform = '';
      api.setMove(0);
    };
    joy.addEventListener('pointerup', end);
    joy.addEventListener('pointercancel', end);
    joy.addEventListener('lostpointercapture', end);
    joy.addEventListener('contextmenu', (e) => e.preventDefault());

    const hold = (id: string, down: () => void, up?: () => void) => {
      const b = document.getElementById(id)!;
      b.addEventListener('pointerdown', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        api.onFirstGesture();
        b.classList.add('is-down');
        try {
          b.setPointerCapture(ev.pointerId);
        } catch {
          /* ignore */
        }
        down();
      });
      const release = (ev?: PointerEvent) => {
        if (ev && ev.button !== undefined && ev.button !== 0 && ev.pointerType === 'mouse') return;
        b.classList.remove('is-down');
        up?.();
      };
      b.addEventListener('pointerup', release);
      b.addEventListener('pointercancel', release);
      // 松开后清掉按住态。只用 lostpointercapture 会在某些浏览器上让 dig 一直按住，
      // 所以指针离开窗口时也补一刀。
      b.addEventListener('lostpointercapture', () => release());
      b.addEventListener('pointerleave', (ev) => {
        if (ev.pointerType !== 'mouse') return;
        if (ev.buttons === 0) release();
      });
      b.addEventListener('contextmenu', (e) => e.preventDefault());
    };
    hold('btn-jump', () => api.setJump(true), () => api.setJump(false));
    hold('btn-dig', () => api.setDig(true), () => api.setDig(false));
    hold('btn-place', () => api.place());
  }

  bindKeyboard(toggleBag: () => void) {
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
      if (e.key === 'e' || e.key === 'E') toggleBag();
      if (e.key === 'Escape' && this.panel !== 'none') this.h.onClosePanel();
      if (e.key === 'm' || e.key === 'M') this.h.onOpenPanel(this.panel === 'menu' ? 'none' : 'menu');
    });
  }

  setHotbarActive(i: number) {
    this.activeSlot = i;
    this.hotbarEl.querySelectorAll('.slot').forEach((s, idx) => {
      s.classList.toggle('is-active', idx === i);
      s.setAttribute('aria-selected', idx === i ? 'true' : 'false');
    });
  }

  /**
   * 顶栏的保存状态。
   *
   * 有未落盘的改动时显示「N 格待保存」，全部写完后显示一次「已保存」再淡出。
   * 只在文案变化时碰 DOM，且由 main 的帧循环调用 —— 不影响每帧预算。
   */
  setSaveState(dirty: number, lastSaveAt: number) {
    const now = Date.now();
    let text = '';
    if (dirty > 0) text = `${dirty} 格待保存`;
    else if (lastSaveAt && now - lastSaveAt < 2400) text = '已保存';
    if (text === this.saveSig) return;
    this.saveSig = text;
    this.saveEl.textContent = text;
    this.saveEl.hidden = !text;
  }

  sync(inv: InventoryData, seedText: string) {
    this.inv = inv;
    this.seedEl.textContent = `种子 ${seedText}`;
    const sig = inv.hotbar.map((k) => `${k}:${k ? inv.counts[k] ?? 0 : 0}`).join('|') + `#${this.activeSlot}`;
    if (sig !== this.hotbarSig) {
      this.hotbarSig = sig;
      this.renderHotbar();
    }
    if (this.panel !== 'none') this.renderPanel();
  }

  private renderHotbar() {
    const inv = this.inv!;
    this.hotbarEl.innerHTML = '';
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      const key = inv.hotbar[i];
      const b = el('button', `slot touch${i === this.activeSlot ? ' is-active' : ''}`);
      b.dataset.slot = String(i);
      const n = key ? inv.counts[key] ?? 0 : 0;
      if (key) {
        const img = document.createElement('img');
        img.src = blockIcon(key);
        img.alt = blockByKey(key)?.name ?? key;
        b.append(img);
        const num = el('span', 'slot__n', String(n));
        if (n <= 0) num.style.color = '#ff8f7a';
        b.append(num, el('span', 'slot__k', String(i + 1)), el('span', 'slot__name', blockByKey(key)?.name ?? key));
        b.setAttribute('aria-label', `${blockByKey(key)?.name} ×${n}`);
      } else {
        b.append(el('span', 'slot__k', String(i + 1)));
        b.setAttribute('aria-label', `空槽位 ${i + 1}`);
      }
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        this.h.onSlot(i);
      });
      this.hotbarEl.append(b);
    }
  }

  setProgress(p: number) {
    const on = p > 0.01 && this.panel === 'none';
    this.progressEl.classList.toggle('is-on', on);
    this.progressFill.style.width = `${Math.round(clamp(p, 0, 1) * 100)}%`;
  }

  setFpsVisible(on: boolean) {
    this.fpsEl.hidden = !on;
  }

  setFps(n: number) {
    if (!this.fpsEl.hidden) this.fpsEl.textContent = `${n} FPS`;
  }

  toast(msg: string, kind: 'ok' | 'warn' = 'ok') {
    const t = this.toastEl;
    t.textContent = msg;
    t.style.borderColor = kind === 'warn' ? 'rgba(255,120,90,.6)' : 'rgba(233,184,114,.4)';
    t.classList.add('is-on');
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => t.classList.remove('is-on'), 1900);
  }

  // ── 面板 ─────────────────────────────────────────────

  openPanel(kind: PanelKind, extra?: PanelExtra) {
    this.panel = kind;
    if (extra) this.lastExtra = extra;
    if (kind === 'none') {
      this.sheet.hidden = true;
      this.sheet.innerHTML = '';
      return;
    }
    this.sheet.hidden = false;
    this.renderPanel();
  }

  private renderPanel() {
    const inv = this.inv;
    const extra = this.lastExtra;
    if (!inv || !extra) return;
    this.sheet.innerHTML = '';
    const panel = el('div', 'panel');
    const titles: Record<string, string> = { bag: '背包', craft: '合成', menu: '菜单与设置' };
    const head = el('div', 'panel__head');
    head.innerHTML = `<div class="panel__title">${titles[this.panel] ?? ''}</div>`;
    const close = el('button', 'iconbtn panel__close', '✕');
    close.setAttribute('aria-label', '关闭');
    close.addEventListener('click', () => this.h.onClosePanel());
    head.append(close);
    panel.append(head);

    const tabs = el('div', 'tabs');
    for (const [k, label] of [
      ['bag', '背包'],
      ['craft', '合成'],
      ['menu', '设置'],
    ] as [PanelKind, string][]) {
      const t = el('button', `tab touch${this.panel === k ? ' is-on' : ''}`, label);
      t.addEventListener('click', () => this.h.onOpenPanel(k));
      tabs.append(t);
    }
    panel.append(tabs);

    const body = el('div', 'panel__body');
    if (this.panel === 'bag') this.renderBag(body, inv);
    else if (this.panel === 'craft') this.renderCraft(body, inv);
    else this.renderMenu(body, inv, extra);
    panel.append(body);
    this.sheet.append(panel);
  }

  private renderBag(body: HTMLElement, inv: InventoryData) {
    const grid = el('div', 'grid');
    for (const b of BLOCKS.filter((x) => x.placeable)) {
      const n = inv.counts[b.key] ?? 0;
      const cell = el('button', `cell touch${n ? '' : ' is-empty'}${inv.hotbar.includes(b.key) ? ' is-on' : ''}`);
      cell.dataset.block = b.key;
      const img = document.createElement('img');
      img.src = blockIcon(b.key);
      img.alt = b.name;
      cell.append(img, el('span', '', b.name), el('span', 'cell__n', `×${n}`));
      cell.title = n ? `${b.name}：点击放入快捷栏` : `${b.name}：还没有`;
      cell.addEventListener('click', () => {
        if (n > 0) this.h.onPickBlock(b.key);
      });
      grid.append(cell);
    }
    body.append(grid);

    const tools = Object.entries(inv.tools.durability);
    const tip = el('div', 'hint');
    tip.style.marginTop = '10px';
    tip.innerHTML =
      '点方块 → 放进快捷栏（自动找空位）。<br>' +
      `<b>工具</b>：${
        tools.length
          ? tools.map(([id, d]) => `${toolById(id)?.name ?? id}（耐久 ${d}/${toolById(id)?.durability}）`).join('、')
          : '暂无 —— 去「合成」做一把石镐'
      }`;
    body.append(tip);
  }

  private renderCraft(body: HTMLElement, inv: InventoryData) {
    for (const r of RECIPES) {
      const row = el('div', 'recipe');
      row.dataset.recipe = r.id;
      const outName = itemName(r.tool ?? r.out!);
      const out = el('div', 'recipe__out');
      const img = document.createElement('img');
      img.src = itemIcon(r.tool ?? r.out!);
      img.alt = outName;
      out.append(img, el('span', '', `${outName}${r.outN && r.outN > 1 ? ` ×${r.outN}` : ''}`));
      row.append(out);

      const need = el('div', 'recipe__need');
      let ok = true;
      for (const ing of r.need) {
        const isBlock = !!blockByKey(ing.item);
        const have = isBlock ? inv.counts[ing.item] ?? 0 : inv.tools.durability[ing.item] ? 1 : 0;
        if (have < ing.n) ok = false;
        const chip = el('span', `ing${have < ing.n ? ' is-miss' : ''}`);
        const ii = document.createElement('img');
        ii.src = itemIcon(ing.item);
        chip.append(ii, el('span', '', `${itemName(ing.item)} ${have}/${ing.n}`));
        need.append(chip);
      }
      row.append(need);

      const btn = el('button', 'btn btn--primary touch', ok ? '合成' : '缺材料');
      (btn as HTMLButtonElement).disabled = !ok;
      btn.dataset.craft = r.id;
      btn.addEventListener('click', () => this.h.onCraft(r));
      row.append(btn);
      if (r.hint) row.append(el('div', 'row__hint', r.hint));
      body.append(row);
    }
  }

  private renderMenu(body: HTMLElement, inv: InventoryData, extra: PanelExtra) {
    const s = extra.settings;
    const addRow = (label: string, control: HTMLElement, hint?: string) => {
      const r = el('div', 'row');
      r.append(el('div', 'row__label', label), control);
      if (hint) r.append(el('div', 'row__hint', hint));
      body.append(r);
      return r;
    };

    const range = (key: string, min: number, max: number, step: number) => {
      const v = document.createElement('input');
      v.type = 'range';
      v.min = String(min);
      v.max = String(max);
      v.step = String(step);
      v.value = String(s[key]);
      v.id = `set-${key}`;
      v.addEventListener('input', () => {
        (v.nextElementSibling as HTMLElement).textContent = v.value;
      });
      v.addEventListener('change', () => this.h.onSetting(key, Number(v.value)));
      const out = document.createElement('span');
      out.style.font = '12px ui-monospace, monospace';
      out.textContent = String(s[key]);
      const wrap = el('div');
      wrap.style.display = 'flex';
      wrap.style.alignItems = 'center';
      wrap.style.gap = '8px';
      wrap.append(v, out);
      return wrap;
    };

    const toggle = (key: string, on: string, off: string) => {
      const b = el('button', 'btn touch', s[key] ? on : off);
      b.id = `set-${key}`;
      b.addEventListener('click', () => this.h.onSetting(key, !s[key]));
      return b;
    };

    addRow('主音量', range('vol', 0, 1, 0.05));
    addRow('音效', toggle('sfx', '开启', '关闭'));
    addRow('长按连挖间隔', range('digHoldMs', 120, 400, 20), '越短挖得越快，手指也越累。默认 180 毫秒。');
    addRow('显示帧率', toggle('showFps', '显示', '隐藏'), `当前 ${extra.quality} 档`);

    const q = document.createElement('select');
    q.id = 'set-quality';
    for (const [v, label] of [
      ['auto', '自动（按帧率降档）'],
      ['high', '高'],
      ['mid', '中'],
      ['low', '低（省电）'],
    ]) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = label;
      if (s.quality === v) o.selected = true;
      q.append(o);
    }
    q.addEventListener('change', () => this.h.onSetting('quality', q.value));
    addRow('画质', q);

    // 存档
    const saveRow = el('div', 'row');
    saveRow.append(el('div', 'row__label', '存档'));
    const now = el('button', 'btn touch', '立即保存');
    now.id = 'btn-savenow';
    now.addEventListener('click', () => this.h.onSaveNow());
    const exp = el('button', 'btn btn--primary touch', '导出存档');
    exp.id = 'btn-export';
    exp.addEventListener('click', () => this.h.onExport());
    const imp = el('button', 'btn touch', '导入存档');
    imp.id = 'btn-import';
    imp.addEventListener('click', () => this.h.onImport());
    saveRow.append(now, exp, imp);
    saveRow.append(
      el(
        'div',
        'row__hint',
        `改动会自动保存（停下约 1 秒、每 8 秒兜底、切后台必存），这个键只是让你心里有底。` +
          `${extra.chunks} 个改动过的区块 · 已游玩 ${fmtDuration(extra.playSec)} · 最近备份 ${fmtDate(s.lastExport)}`,
      ),
    );
    body.append(saveRow);

    const newRow = el('div', 'row');
    newRow.append(el('div', 'row__label', '重新开一局'));
    const nw = el('button', 'btn btn--danger touch', '新世界');
    nw.id = 'btn-new';
    nw.addEventListener('click', () => this.h.onNewWorld());
    newRow.append(nw);
    newRow.append(el('div', 'row__hint', '当前世界会被覆盖。想保留的话，先导出一份。'));
    body.append(newRow);

    const help = el('div', 'hint');
    help.style.marginTop = '12px';
    help.innerHTML =
      '<b>操作</b>：左摇杆移动；跳跃键可按住连跳；按住「挖」连续挖；「放」把快捷栏选中的方块放到身前。<br>' +
      '桌面键鼠：A/D 或 ←/→ 移动，空格跳，Z 挖，X 放，1–6 选格，E 背包，M 菜单，Esc 关闭。<br>' +
      '<b>开局路线</b>：徒手敲苔土 → 挖岩层得碎石 → 合成石镐 → 往下挖铜脉 → 做火把照亮。<br>' +
      `工具：${Object.keys(inv.tools.durability).length ? Object.keys(inv.tools.durability).map(itemName).join('、') : '无'}`;
    body.append(help);

    const about = el('div', 'kv');
    about.style.marginTop = '12px';
    about.innerHTML = `<span>版本</span><b>v${extra.ver} · build ${extra.build}</b>
      <span>种子</span><b>${extra.seedText}</b>
      <span>关于</span><b>《地髓 Eartheno》为原创独立作品，机制灵感来自沙盒建造品类，与任何商业作品无关联。</b>`;
    body.append(about);
  }
}
