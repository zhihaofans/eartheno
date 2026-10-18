import { describe, it, expect } from 'vitest';
import {
  writeVarint,
  readVarint,
  rleEncode,
  rleDecode,
  bytesToBase64,
  base64ToBytes,
  makeSaveFile,
  encodeSave,
  importSave,
  chunkKey,
  parseChunkKey,
  newMeta,
  migrateSkyRows,
  CHUNK,
  type MetaState,
} from '../../src/core/save';
import { CHUNK_AREA, APP_ID, SAVE_FMT } from '../../src/core/constants';
import { emptyInventory, add } from '../../src/core/inventory';

function roundTripChunk(blocks: Uint8Array) {
  return rleDecode(rleEncode(blocks));
}

function sampleMeta(): MetaState {
  const m = newMeta(0x1a2b3c4d, { x: 3.5, y: 70 });
  add(m.inv, 'stone', 42);
  m.inv.tools.durability.pick_stone = 55;
  m.inv.tools.held = 'pick_stone';
  m.player.playSec = 512;
  m.deepest = 132;
  return m;
}

describe('变长整数', () => {
  it('往返一致（含边界值）', () => {
    for (const v of [0, 1, 127, 128, 255, 16383, 16384, 0x7fffffff, 0xffffffff]) {
      const out: number[] = [];
      writeVarint(out, v);
      const { value, next } = readVarint(new Uint8Array(out), 0);
      expect(value).toBe(v >>> 0);
      expect(next).toBe(out.length);
    }
  });

  it('大数比小数占用更多字节', () => {
    const a: number[] = [];
    const b: number[] = [];
    writeVarint(a, 1);
    writeVarint(b, 100000);
    expect(a.length).toBeLessThan(b.length);
  });

  it('数据截断时抛错（而不是静默返回错值）', () => {
    expect(() => readVarint(new Uint8Array([0x80, 0x80]), 0)).toThrow();
  });
});

describe('base64url', () => {
  it('往返一致', () => {
    for (const len of [0, 1, 2, 3, 4, 5, 17, 64, 1000]) {
      const buf = new Uint8Array(len);
      for (let i = 0; i < len; i++) buf[i] = (i * 37 + 11) & 0xff;
      expect(Array.from(base64ToBytes(bytesToBase64(buf)))).toEqual(Array.from(buf));
    }
  });

  it('只使用 URL 安全字符', () => {
    const buf = new Uint8Array(256);
    for (let i = 0; i < 256; i++) buf[i] = i;
    const text = bytesToBase64(buf);
    expect(text).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('非法字符抛错', () => {
    expect(() => base64ToBytes('abc$def')).toThrow();
  });
});

describe('RLE 区块编码', () => {
  it('全空区块压得极小', () => {
    const empty = new Uint8Array(CHUNK_AREA);
    const text = rleEncode(empty);
    expect(text.length).toBeLessThan(8);
    expect(Array.from(roundTripChunk(empty))).toEqual(Array.from(empty));
  });

  it('真实地形区块 80–400 字符（经验文档给的量级）', () => {
    // 用一段"像地形"的数据：上方空气 + 中间交错 + 底部石头
    const buf = new Uint8Array(CHUNK_AREA);
    for (let y = 0; y < CHUNK; y++) {
      for (let x = 0; x < CHUNK; x++) {
        const id = y < 12 ? 0 : y < 16 ? 1 : y < 20 ? 2 : (x * y) % 7 === 0 ? 10 : 3;
        buf[y * CHUNK + x] = id;
      }
    }
    const text = rleEncode(buf);
    expect(text.length).toBeGreaterThan(60);
    expect(text.length).toBeLessThan(600);
  });

  it('随机内容往返无损', () => {
    let seed = 12345;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const buf = new Uint8Array(CHUNK_AREA);
    for (let i = 0; i < CHUNK_AREA; i++) buf[i] = Math.floor(rand() * 16);
    expect(Array.from(roundTripChunk(buf))).toEqual(Array.from(buf));
  });

  it('长度不对的编码会抛错', () => {
    expect(() => rleDecode(rleEncode(new Uint8Array(100)))).toThrow();
  });
});

describe('存档导出 / 导入', () => {
  it('往返一致：meta 与 chunk 都还原', () => {
    const meta = sampleMeta();
    const chunks = new Map<string, Uint8Array>();
    const c = new Uint8Array(CHUNK_AREA);
    c.fill(3);
    chunks.set(chunkKey(0, 2), c);

    const text = encodeSave(makeSaveFile(meta, chunks, '0.1.0'));
    const res = importSave(text);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.save.meta.seed).toBe(meta.seed);
    expect(res.save.meta.inv.counts.stone).toBe(42);
    expect(res.save.meta.inv.tools.held).toBe('pick_stone');
    expect(res.save.meta.player.playSec).toBe(512);
    expect(Array.from(res.chunks.get('0,2')!)).toEqual(Array.from(c));
  });

  it('chunk 按坐标排序，导出结果稳定（方便人眼 diff）', () => {
    const meta = sampleMeta();
    const chunks = new Map<string, Uint8Array>();
    for (const [cx, cy] of [[3, 1], [-1, 2], [0, 5], [-1, 0]] as [number, number][]) {
      chunks.set(chunkKey(cx, cy), new Uint8Array(CHUNK_AREA));
    }
    const save = makeSaveFile(meta, chunks, '0.1.0');
    expect(save.chunks.map((c) => [c.cx, c.cy])).toEqual([[-1, 0], [-1, 2], [0, 5], [3, 1]]);
  });

  it('导出文件带 app / fmt / ver 三个版本标识', () => {
    const save = makeSaveFile(sampleMeta(), new Map(), '1.2.3');
    expect(save.app).toBe(APP_ID);
    expect(save.fmt).toBe(SAVE_FMT);
    expect(save.ver).toBe('1.2.3');
    expect(save.savedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('空世界也能导出导入', () => {
    const text = encodeSave(makeSaveFile(newMeta(1, { x: 0, y: 70 }), new Map(), '0.1.0'));
    const res = importSave(text);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.chunks.size).toBe(0);
  });
});

describe('导入的错误分类（要能告诉用户具体哪错了）', () => {
  it('不是 JSON → NOT_JSON', () => {
    const r = importSave('这不是 json');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('NOT_JSON');
  });

  it('是 JSON 但不是《地髓》存档 → NOT_EARTHENO', () => {
    const r = importSave(JSON.stringify({ app: 'minecraft', fmt: 1 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('NOT_EARTHENO');
  });

  it('缺少 fmt → BAD_META', () => {
    const r = importSave(JSON.stringify({ app: APP_ID, meta: {} }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('BAD_META');
  });

  it('fmt 比当前版本新 → FMT_TOO_NEW（而不是硬崩）', () => {
    const r = importSave(JSON.stringify({ app: APP_ID, fmt: SAVE_FMT + 1, meta: {} }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('FMT_TOO_NEW');
      expect(r.error.detail).toContain('更新');
    }
  });

  it('meta 缺失 → BAD_META', () => {
    const r = importSave(JSON.stringify({ app: APP_ID, fmt: SAVE_FMT }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('BAD_META');
  });

  it('chunk 字段不全 → BAD_CHUNK', () => {
    const meta = newMeta(1, { x: 0, y: 70 });
    const r = importSave(JSON.stringify({ app: APP_ID, fmt: SAVE_FMT, meta, chunks: [{ cx: 0, rle: '' }] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('BAD_CHUNK');
  });

  it('chunk 数据损坏 → BAD_CHUNK，且 detail 指出是哪个区块', () => {
    const meta = newMeta(1, { x: 0, y: 70 });
    const r = importSave(
      JSON.stringify({ app: APP_ID, fmt: SAVE_FMT, meta, chunks: [{ cx: 7, cy: 2, rle: '!!!!' }] }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('BAD_CHUNK');
      expect(r.error.detail).toContain('7');
    }
  });

  it('前后空白容错（用户粘贴时容易带上换行）', () => {
    const text = encodeSave(makeSaveFile(sampleMeta(), new Map(), '0.1.0'));
    expect(importSave(`\n\n  ${text}  \n`).ok).toBe(true);
  });
});

describe('meta 逐字段重建（防用户数据悄悄丢失）', () => {
  it('缺失字段用默认值补，不抛错', () => {
    const r = importSave(JSON.stringify({ app: APP_ID, fmt: SAVE_FMT, meta: { seed: 7 }, chunks: [] }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const m = r.save.meta;
    expect(m.seed).toBe(7);
    expect(m.player.x).toBe(0);
    expect(m.player.y).toBe(80);
    expect(m.player.facing).toBe(1);
    expect(m.player.active).toBe(0);
    expect(m.inv.hotbar).toHaveLength(6);
    expect(m.deepest).toBe(90);
  });

  it('非法数值被夹到合法范围（active / playSec / facing）', () => {
    const r = importSave(
      JSON.stringify({
        app: APP_ID,
        fmt: SAVE_FMT,
        chunks: [],
        meta: { seed: 1, player: { active: 99, playSec: -50, facing: 7, x: 'NaN', y: null } },
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = r.save.meta.player;
    expect(p.active).toBe(5); // 越界 → 夹到快捷栏最后一格
    expect(p.playSec).toBe(0);
    expect(p.facing).toBe(1);
    expect(p.x).toBe(0);
    expect(p.y).toBe(80);
  });

  it('seed 以 uint32 归一（负数也能接受）', () => {
    const r = importSave(JSON.stringify({ app: APP_ID, fmt: SAVE_FMT, chunks: [], meta: { seed: -1 } }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.save.meta.seed).toBe(0xffffffff);
  });

  it('savedAt / createdAt 缺失时补当前时间', () => {
    const r = importSave(JSON.stringify({ app: APP_ID, fmt: SAVE_FMT, chunks: [], meta: { seed: 1 } }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Number.isNaN(Date.parse(r.save.meta.createdAt))).toBe(false);
      expect(Number.isNaN(Date.parse(r.save.meta.savedAt))).toBe(false);
    }
  });

  it('背包经清洗后回来（未知方块剔除）', () => {
    const r = importSave(
      JSON.stringify({
        app: APP_ID,
        fmt: SAVE_FMT,
        chunks: [],
        meta: { seed: 1, inv: { counts: { stone: 5, 不存在: 9 }, hotbar: ['stone'], tools: {} } },
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.save.meta.inv.counts.stone).toBe(5);
      expect(Object.keys(r.save.meta.inv.counts)).toEqual(['stone']);
    }
  });
});

describe('chunk key', () => {
  it('往返一致，负坐标也对', () => {
    for (const [cx, cy] of [[0, 0], [-1, 2], [255, 8], [-256, 0]] as [number, number][]) {
      expect(parseChunkKey(chunkKey(cx, cy))).toEqual([cx, cy]);
    }
  });
});

describe('新世界初始状态', () => {
  it('newMeta 给出可玩的默认值', () => {
    const m = newMeta(42, { x: 3.5, y: 70 });
    expect(m.seed).toBe(42);
    expect(m.player.x).toBe(3.5);
    expect(m.player.facing).toBe(1);
    expect(m.player.playSec).toBe(0);
    expect(m.inv).toEqual(emptyInventory());
    expect(m.deepest).toBe(70);
  });
});

describe('老存档的天空迁移（世界顶部上移两行）', () => {
  const gen = (seed: number) => (cx: number, cy: number) => {
    const out = new Uint8Array(CHUNK_AREA);
    // 假的"生成器"：天空行给空气，其余给岩层 —— 只为验证逐字节比对与替换
    if (cy >= 0) out.fill(3);
    void seed;
    return out;
  };

  it('只改天空两行，玩家的地面改动原样保留', () => {
    const chunks = new Map<string, Uint8Array>();
    const sky = new Uint8Array(CHUNK_AREA);
    sky[100] = 7; // 旧版可能在天空里塞了块木头
    chunks.set(chunkKey(0, -1), sky);
    const ground = new Uint8Array(CHUNK_AREA);
    ground.fill(3);
    ground[0] = 0; // 玩家挖掉的一格
    chunks.set(chunkKey(0, 0), ground);

    const touched = migrateSkyRows(chunks, gen(1));
    expect(touched).toBe(true);
    // 天空行的异常方块被清掉
    expect(chunks.get(chunkKey(0, -1))![100]).toBe(0);
    // 第 0 行不该被动
    expect(chunks.get(chunkKey(0, 0))![0]).toBe(0);
    expect(chunks.get(chunkKey(0, 0))![1]).toBe(3);
  });

  it('没有天空 chunk 时什么都不做（新存档走这条路）', () => {
    const chunks = new Map<string, Uint8Array>();
    expect(migrateSkyRows(chunks, gen(1))).toBe(false);
    expect(chunks.size).toBe(0);
  });

  it('生成器返回 null（越界）时不崩', () => {
    const chunks = new Map<string, Uint8Array>();
    chunks.set(chunkKey(0, -1), new Uint8Array(CHUNK_AREA));
    expect(migrateSkyRows(chunks, () => null)).toBe(false);
  });
});
