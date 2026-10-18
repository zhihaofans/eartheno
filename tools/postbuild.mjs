#!/usr/bin/env node
/**
 * 构建后处理（vite build 之后跑）：
 *
 * ① 生成构建号（时间戳 base36），写进 sw.js 与 version.json。
 *    为什么不用 vite 的内容哈希：SW 文件本身内容不变时浏览器不会认为它"更新了"，
 *    而我们要在每次发版后让老客户端发现"有新版本"。
 * ② 枚举产物目录下的实际产物，注入 sw.js 的 PRECACHE 列表。
 *    不用 glob 猜路径 —— 带内容哈希的 js/css 名字每次构建都变，猜错就等于没缓存。
 * ③ 打印构建报告（体积、gzip、文件数），超预算直接失败（CI 能拦住）。
 * ④ 清理 <outDir>/assets 里的旧哈希产物（经验文档 §12：内容哈希 + SW 接管会导致
 *    "旧页面请求旧哈希文件"，全删就会白屏 —— 所以 build.emptyOutDir=false，
 *    然后在这里按"同前缀只留最新一份"精确回收，避免版本无限堆积。
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join, dirname, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// 产物目录：默认 docs/（GitHub Pages 能直接指定的唯一子目录）。
// 允许用 OUT_DIR 覆盖，方便 CI 或本地临时试验其它目录。
const DIST = join(ROOT, process.env.OUT_DIR || 'docs');
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

if (!existsSync(DIST)) {
  console.error(`${DIST} 不存在，先跑 vite build`);
  process.exit(1);
}

// GitHub Pages 默认会跑 Jekyll。Jekyll 会忽略下划线开头的文件/目录，
// 并且对二进制资源无谓地过一遍处理。放一个 .nojekyll 直接关掉。
// 这个文件必须由构建产生（docs/ 是被清空重建的产物目录，手放会被冲掉）。
writeFileSync(join(DIST, '.nojekyll'), '');

// ── 构建号 ────────────────────────────────────────────────
const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
const build = `${stamp}-${now.getTime().toString(36).slice(-4)}`;
const ver = PKG.version;

// ── 递归列出产物目录里的静态资源 ──────────────────────────
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

// ── 清理旧一代 assets ────────────────────────────────────
// 必须放在枚举 precache 与体积统计**之前**：否则上一代的哈希文件会被
// ① 写进新的 precache 列表（下次启动白拉一堆死文件）② 计入首屏体积（误报超支）。
//
// 分代策略：**按打包前缀分组，每组只留最新的一个**。
// 不用 mtime 分代 —— 构建只要几秒，一次构建的产物 mtime 差不到 2s，
// 用时间窗分代会把三四代旧 index-*.js 全认成"当前这一代"，一个都删不掉
// （这个 bug 真的发生过：预算误报 419 kB，实际产物里躺着三代 index）。
// 前缀规则：`index-<hash>.js` / `phaser-<hash>.js` → 前缀 `index` / `phaser`；
// 非哈希文件（如固定名 favicon）保持原名作前缀，永远不会被误删。
const assetsDir = join(DIST, 'assets');
let pruned = 0;
if (existsSync(assetsDir)) {
  const groups = new Map();
  for (const name of readdirSync(assetsDir)) {
    const full = join(assetsDir, name);
    const st = statSync(full);
    if (!st.isFile()) continue;
    const ext = extname(name);
    const stem = name.slice(0, name.length - ext.length);
    // 结尾 8 位以上的 base64url 串才认作内容哈希。
    // 必须允许 `-` 和 `_`：Vite 生成的哈希是 base64url，常见形如 `index-C-tA51Ea`，
    // 只匹配 `[A-Za-z0-9_]` 会把 `C` 和 `tA51Ea` 当成两截，分组分错就删不掉旧文件。
    const m = /^(.*)-([A-Za-z0-9_-]{8,})$/.exec(stem);
    const key = `${m ? m[1] : stem}${ext}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ name, full, mtime: st.mtimeMs });
  }
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => b.mtime - a.mtime);
    // 同前缀只保留最新一份（同一次构建不会产出同前缀多文件；
    // 极端情况如 `index-1.js` + `index-abc12345.js` 也安全：前者不会被当作哈希）
    for (const f of list.slice(1)) {
      try {
        rmSync(f.full);
        pruned++;
      } catch {
        /* 删不掉就留着，不影响运行 */
      }
    }
  }
}

const all = walk(DIST);
/** SW 自己与 version.json 不进预缓存（必须永远拿网络上的最新版） */
const EXCLUDE = new Set([
  'sw.js',
  'version.json',
  'precache.json',
  '.DS_Store',
  '.nojekyll', // 给 GitHub Pages 看的空文件，不该占预缓存名额
  '.build-meta.json', // 构建脚本自己的状态文件，不该被访问到
]);

function toUrl(abs) {
  const rel = relative(DIST, abs).split('\\').join('/');
  return `./${rel}`;
}

const precache = all
  .filter((f) => !EXCLUDE.has(relative(DIST, f).split('\\').join('/')))
  .map(toUrl);

// ── 把 %BASE% 占位替换成真实 base（index.html + manifest）──
//
// 为什么需要这一步：`public/` 下的文件不走打包，Vite 不会重写它们里面的路径。
// 而这两份文件都含"必须跟着部署路径走"的 URL：
//   index.html → manifest / 图标的引用
//   manifest   → id / start_url / scope / 图标 src
//
// **base 从产物里反推**，不读环境变量：看 index.html 里 Vite 自己生成的
// script src，`/eartheno/assets/x.js` → `/eartheno/`，`./assets/x.js` → `./`。
// 这样即使外面用 GHP_BASE 构建，这里的判断也绝不会和 Vite 打架。
//
// manifest 里的 id 尤其重要：它是 PWA 的**身份标识**。早期版本把 id 写死成
// "/eartheno/"，导致部署到别的仓库名时，浏览器认为"这是同一应用的另一份副本"，
// 可能覆盖已有安装、或让 start_url 指向不存在的路径。
const htmlPath = join(DIST, 'index.html');
if (!existsSync(htmlPath)) {
  console.error('产物里没有 index.html');
  process.exit(1);
}
let html = readFileSync(htmlPath, 'utf8');
let base = './';
{
  const m = /<(?:script|link)[^>]+(?:src|href)="([^"]*?)assets\//.exec(html);
  if (m) base = m[1] || './';
}
if (html.includes('%BASE%')) {
  html = html.split('%BASE%').join(base);
  writeFileSync(htmlPath, html);
}

const mfPath = join(DIST, 'manifest.webmanifest');
if (existsSync(mfPath)) {
  let mf = readFileSync(mfPath, 'utf8');
  if (mf.includes('%BASE%')) {
    // 图标路径：base 为 "./" 时写成 "icons/x.png"（相对 manifest 自身，最兼容），
    // 绝对 base 时写成 "/repo/icons/x.png"。
    const iconBase = base === './' ? '' : base;
    mf = mf.split('%BASE%icons/').join(`${iconBase}icons/`);
    mf = mf.split('%BASE%').join(base);
    writeFileSync(mfPath, mf);
  }
  // 校验：JSON 必须能解析，且 id / start_url / scope 不能残留占位符
  try {
    const j = JSON.parse(readFileSync(mfPath, 'utf8'));
    for (const k of ['id', 'start_url', 'scope']) {
      if (typeof j[k] !== 'string' || j[k].includes('%BASE%')) {
        console.error(`manifest 的 ${k} 没被正确替换：${j[k]}`);
        process.exit(1);
      }
    }
    const badIcon = (j.icons || []).find((i) => String(i.src).includes('%BASE%'));
    if (badIcon) {
      console.error(`manifest 图标路径残留占位符：${badIcon.src}`);
      process.exit(1);
    }
  } catch (e) {
    console.error('manifest 不是合法 JSON：', e.message);
    process.exit(1);
  }
}

// ── 注入 sw.js ────────────────────────────────────────────
const swPath = join(DIST, 'sw.js');
if (!existsSync(swPath)) {
  console.error('dist/sw.js 不存在 —— public/sw.js 没被复制过去？');
  process.exit(1);
}
let sw = readFileSync(swPath, 'utf8');
if (!sw.includes('__BUILD__')) console.warn('警告：sw.js 里找不到 __BUILD__ 占位符');
if (!sw.includes('__PRECACHE__')) console.warn('警告：sw.js 里找不到 __PRECACHE__ 占位符');
sw = sw.replace(/__BUILD__/g, build);
sw = sw.replace('__PRECACHE__', JSON.stringify(precache, null, 2));
writeFileSync(swPath, sw);

// ── version.json（不进缓存，页面用它比对更新）──────────────
const version = { ver, build, builtAt: now.toISOString(), note: '地髓 Eartheno' };
writeFileSync(join(DIST, 'version.json'), JSON.stringify(version, null, 2) + '\n');

// ── precache.json（调试/审计用，SW 不读它）─────────────────
writeFileSync(join(DIST, 'precache.json'), JSON.stringify({ build, files: precache }, null, 2) + '\n');

// ── 构建报告 ─────────────────────────────────────────────
const rows = [];
let totalRaw = 0;
let totalGz = 0;
for (const f of walk(DIST)) {
  const rel = relative(DIST, f).split('\\').join('/');
  const buf = readFileSync(f);
  const gz = gzipSync(buf, { level: 9 }).length;
  totalRaw += buf.length;
  totalGz += gz;
  rows.push({ rel, raw: buf.length, gz });
}
rows.sort((a, b) => b.raw - a.raw);

const kb = (n) => `${(n / 1024).toFixed(2)} kB`;
console.log('\n构建产物：');
for (const r of rows) {
  if (r.raw < 1024) continue;
  console.log(`  ${r.rel.padEnd(42)} ${kb(r.raw).padStart(11)}  gzip ${kb(r.gz).padStart(10)}`);
}
console.log(`  ${'总计'.padEnd(40)} ${kb(totalRaw).padStart(11)}  gzip ${kb(totalGz).padStart(10)}`);
console.log(`\n  构建号 ${build}   版本 ${ver}   预缓存 ${precache.length} 个文件${pruned ? `   清理旧产物 ${pruned} 个` : ''}`);

/**
 * 首屏预算：**代码**（html + js + css）gzip 后 < 400 kB。
 * 图片不计入 —— 图标是安装时才下载的，不该卡首屏预算。
 */
const CODE_EXT = new Set(['.html', '.js', '.css', '.webmanifest']);
let codeGz = 0;
for (const r of rows) if (CODE_EXT.has(extname(r.rel))) codeGz += r.gz;
console.log(`  首屏代码 gzip ${kb(codeGz)}（预算 400 kB）`);
const BUDGET = 400 * 1024;
if (codeGz > BUDGET) {
  console.error(`\n首屏代码超出预算：gzip ${kb(codeGz)} > ${kb(BUDGET)}`);
  process.exit(1);
}
