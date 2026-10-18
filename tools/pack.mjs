#!/usr/bin/env node
/**
 * 打一个可以直接交付的源码包：`地髓Eartheno-完整仓库-v<version>.zip`。
 *
 * 为什么用脚本而不是手动 `zip -r`：
 * ① **包名里的版本号必须来自 package.json** —— 手写必错，而且错了没人发现
 *    （玩家下到的是 v0.1 的包，却以为是新的）。
 * ② 排除清单容易漏：`node_modules/`、`test-results/`、`playwright-report/`、
 *    各类 `.DS_Store` / `.zip` / 日志，漏一个包就胖一圈。
 * ③ 打完要能一眼确认：文件数、体积、版本，以及**必须包含 docs/**（Pages 发布源）。
 *
 * 用法：
 *   npm run pack              # 默认打当前 version
 *   npm run pack -- --skip-build   # 已有最新 docs/，不重新构建
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const version = PKG.version;
const zipName = `地髓Eartheno-完整仓库-v${version}.zip`;
const zipPath = join(ROOT, zipName);

const skipBuild = process.argv.includes('--skip-build');
if (!skipBuild) {
  // 关键：沿用**上一次构建用的 base**，不要退回默认值。
  // 之前这里有坑：`npm run pack` 内部会跑 build.mjs，而 build.mjs 默认 base 是 '/'，
  // 于是"刚用 GHP_BASE=/eartheno/ 构建好、准备发 Pages 的产物"会被悄悄改成根路径版本，
  // 打出来的包里 scope 变成 "/"，又回到线上白屏那个问题。
  // 现在从 docs/.build-meta.json（build.mjs 写的）读回上次的 base。
  const metaPath = join(ROOT, 'docs', '.build-meta.json');
  if (!process.env.GHP_BASE && existsSync(metaPath)) {
    try {
      const prev = JSON.parse(readFileSync(metaPath, 'utf8')).base;
      if (prev && prev !== './') {
        process.env.GHP_BASE = prev;
        console.log(`沿用上次构建的 base：${prev}`);
      }
    } catch {
      /* 标记文件坏了就用默认值 */
    }
  }
  console.log('先构建一次产物（docs/ 要跟着版本号走）…');
  execFileSync(process.execPath, [join(ROOT, 'tools', 'build.mjs')], { cwd: ROOT, stdio: 'inherit' });
}

// 要打进去的顶层条目。**docs/ 必须在列**：它是 GitHub Pages 的发布源。
const INCLUDE = [
  'DEPLOY.md',
  'README.md',
  'CHANGELOG.md',
  'index.html',
  'package.json',
  'package-lock.json',
  'playwright.config.ts',
  'tsconfig.json',
  'vite.config.ts',
  '.gitignore',
  '.github',
  'public',
  'screenshots',
  'src',
  'tests',
  'tools',
  'docs',
  '地髓Eartheno-开发方案-v1.md',
];

const EXCLUDE = [
  '*/node_modules/*',
  'node_modules/*',
  'test-results/*',
  'playwright-report/*',
  '.git/*',
  '*/.DS_Store',
  '*.log',
  // 构建脚本的状态标记：记录上次用的 base，每台机器都不一样，
  // 带进去只会让人以为"解压出来怎么 base 和我不一样"。
  'docs/.build-meta.json',
  // 发布包自身，别把上一个 zip 打进下一个 zip
  '地髓Eartheno-完整仓库-*.zip',
];

const present = INCLUDE.filter((p) => existsSync(join(ROOT, p)));
const missing = INCLUDE.filter((p) => !existsSync(join(ROOT, p)));
if (!present.includes('docs')) {
  console.error('✗ 没有 docs/ 目录，先跑 npm run build（Pages 的发布源就是它）');
  process.exit(1);
}
if (missing.length) console.log(`提示：跳过了不存在的条目 ${missing.join(', ')}`);

if (existsSync(zipPath)) rmSync(zipPath);

const args = ['-rq', zipPath, ...present, '-x', ...EXCLUDE];
execFileSync('zip', args, { cwd: ROOT, stdio: 'inherit' });

// 自检：解出来看看文件数与体积，并确认三样关键文件都在
const list = execFileSync('unzip', ['-l', zipPath], { encoding: 'utf8' });
const count = Number(/(\d+) files?$/.exec(list.trim())?.[1] ?? 0);
const bytes = statSync(zipPath).size;

const must = [
  'package.json',
  'src/main.ts',
  'docs/index.html',
  'docs/sw.js',
  'docs/version.json',
  // .nojekyll 决定 GitHub Pages 会不会跑 Jekyll。它是隐藏文件，
  // 用网页拖拽上传 / 某些 FTP 客户端会静默丢掉，所以打包时必须确认它真的在里面。
  'docs/.nojekyll',
];
const bad = must.filter((m) => !list.includes(` ${m}`));
if (bad.length) {
  console.error(`✗ 包里缺少关键文件：${bad.join(', ')}`);
  process.exit(1);
}

// 产物形态自检：manifest 的 scope 必须是目录，不能是以文件结尾的相对值
{
  const mf = JSON.parse(readFileSync(join(ROOT, 'docs', 'manifest.webmanifest'), 'utf8'));
  if (!String(mf.scope).endsWith('/')) {
    console.error(`✗ docs/manifest.webmanifest 的 scope 不是目录：${mf.scope}\n  线上部署请用 GHP_BASE=/<仓库名>/ npm run build`);
    process.exit(1);
  }
}

// 版本一致性：产物里的 version.json 必须和 package.json 一样
const vj = JSON.parse(readFileSync(join(ROOT, 'docs', 'version.json'), 'utf8'));
if (vj.ver !== version) {
  console.error(`✗ 版本不一致：package.json=${version}，docs/version.json=${vj.ver}\n  先跑 npm run build`);
  process.exit(1);
}

const mb = (bytes / 1024 / 1024).toFixed(2);
console.log(`\n✓ ${zipName}`);
console.log(`  版本 ${version} · ${count} 个文件 · ${mb} MB`);
console.log(`  构建号 ${vj.build}（${vj.builtAt}）`);
console.log('  包含：源码 + 测试 + docs/ 静态产物（GitHub Pages 发布源）');
