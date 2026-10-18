#!/usr/bin/env node
/**
 * 构建入口（package.json 的 build / test:e2e 都走这里）。
 *
 * 为什么不让 npm script 直接串三条命令：
 *  ① 需要一处统一决定 base，并把它**同时**告诉 vite 和 postbuild，
 *     否则两边各读各的环境变量很容易不一致。
 *  ② 需要在构建前后做几项检查（比如 E2E 之前强制用相对 base）。
 *
 * 环境变量：
 *   GHP_BASE=/仓库名/   用绝对 base 构建（GitHub 项目页）
 *   不设                 用相对 base "./"（任意目录部署，也是 E2E 需要的）
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, rmSync, readFileSync } from 'node:fs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** @param {string} cmd @param {string[]} args */
function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: false });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

// E2E 在 http://127.0.0.1:4319/ 根路径上跑产物，产物必须是相对 base。
// 若上一次构建用了 GHP_BASE（绝对路径），产物会全部指向 /仓库名/assets/，
// 测试会 29 个一起 404 —— 报错信息还全是"加载不出游戏"，极难定位。
// 所以 test:e2e 强制清掉这个变量，从入口处杜绝。
if (process.env.E2E_FORCE_RELATIVE === '1' && process.env.GHP_BASE) {
  console.log('test:e2e 需要相对 base，已忽略 GHP_BASE');
  delete process.env.GHP_BASE;
}

const base = process.env.GHP_BASE || './';
console.log(`\n构建 base = ${base}`);

// ── base 变了怎么办 ──────────────────────────────────────
//
// 一开始想的是"base 变了就把 docs/ 整个删掉重建"，结果踩了个更深的坑：
// 如果此时 `vite preview` 已经在跑（E2E 的 webServer 就是），
// **删掉目录会让它的静态文件索引失效**，之后所有请求 404，
// 页面拿到的是 Vite 的 HTML 错误页，用例报 `JSON.parse: "The server..."` ——
// 完全误导人，看起来像 manifest 写坏了。
//
// 正确做法：不删目录，只保证每个文件都被覆盖。Vite 会重写 index.html 与
// assets/ 下的新哈希文件，postbuild 会重写 manifest 与 sw.js，
// base 变化影响的恰好就是这几处。旧哈希文件留着无害（见 emptyOutDir=false 的理由）。
const OUT = join(ROOT, 'docs');
const marker = join(OUT, '.build-meta.json');
const wantBase = process.env.GHP_BASE || './';
if (existsSync(marker)) {
  try {
    const prev = JSON.parse(readFileSync(marker, 'utf8'));
    if (prev.base !== wantBase) {
      console.log(`（base 从 ${prev.base} 变为 ${wantBase}，将覆盖全部产物文件）`);
    }
  } catch {
    /* 标记文件坏了就当没有 */
  }
}

// 类型检查放在最前：类型错了就没必要再打包
run(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['tsc', '--noEmit']);
run(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['vite', 'build']);

// postbuild 自己会从产物里反推 base（不依赖这个环境变量），
// 但显式传过去让语义更清楚：它是"这一次构建的 base"。
run(process.execPath, [join(ROOT, 'tools', 'postbuild.mjs')]);

// 记下这次用的 base，供下次判断"要不要清目录"
const { writeFileSync } = await import('node:fs');
writeFileSync(marker, JSON.stringify({ base: wantBase, at: new Date().toISOString() }, null, 2) + '\n');
