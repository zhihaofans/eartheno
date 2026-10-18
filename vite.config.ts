import { defineConfig } from 'vite';

/**
 * 部署路径（base）的决定逻辑 —— 这里踩过两次，记清楚：
 *
 * **① 默认 base 是 `'/'`，相对 base 只留给本地预览与 E2E。**
 * 早先默认 `'./'`（相对路径），结果线上就吃了亏：
 * 页面正常、资源 200，但 `manifest.webmanifest` 里是 `"start_url": "./"`、
 * `"scope": "./"` —— 这两个字段的相对基准是 **manifest 文件自己所在的目录**，
 * 于是浏览器算出来的 scope 变成了 `/eartheno/manifest.webmanifest`，
 * 一个"以文件路径为前缀"的非法 scope。表现是：Chrome 能装，但装出来的应用
 * 打开是空白的；Safari 里的作用域判断也会跟着歪。
 * 用绝对路径 `"/eartheno/"` 就完全没有这层歧义。
 *
 *   npm run build                      → base '/'（GitHub 用户页 / 自有域名根目录）
 *   GHP_BASE=/eartheno/ npm run build  → base '/eartheno/'（GitHub 项目页）
 *   E2E_FORCE_RELATIVE=1 …             → base './'（本地 127.0.0.1:4319 根路径预览）
 *
 * 相对 base 的另一个隐患：**任何深层 URL**（/repo/a/b/）都会把 './assets' 解析到
 * /repo/a/b/assets 而 404。GitHub Pages 不做 SPA 回退、本项目也不产生深层 URL，
 * 所以相对 base 目前只用于本地预览；线上别用它。
 *
 * **② `GHP_BASE` 没写结尾斜杠时自动补上**（`/eartheno` → `/eartheno/`）。
 * Vite 自己会规整，但 tools/postbuild.mjs 还要拿它拼 manifest / 图标路径，
 * 少一个斜杠就会拼出 `/earthenoicons/x.png`。统一在这里抹平，下游只面对规整值。
 */
function normalizeBase(raw: string): string {
  const v = (raw || '').trim();
  if (!v || v === '/') return '/';
  if (v === './' || v === '.') return './';
  // 完整 URL（CDN 场景）原样返回，只保证结尾斜杠
  if (/^https?:\/\//i.test(v)) return v.endsWith('/') ? v : `${v}/`;
  const withLead = v.startsWith('/') ? v : `/${v}`;
  return withLead.endsWith('/') ? withLead : `${withLead}/`;
}

const base = normalizeBase(process.env.GHP_BASE || (process.env.E2E_FORCE_RELATIVE === '1' ? './' : '/'));

export default defineConfig({
  base,
  build: {
    target: 'es2020',
    // 产物直接输出到 docs/ —— GitHub Pages「Deploy from a branch」只认
    // 仓库根目录或 /docs，这是唯一能被 Pages 直接指定为发布源的子目录。
    outDir: 'docs',
    // 关键：不清空输出目录。文件名带内容哈希，若每次构建都清空，
    // 旧页面引用的旧 JS 会在新 SW 接管的一瞬间 404 → 白屏（经验文档 §12 + §7.7 的冲突）
    emptyOutDir: false,
    assetsInlineLimit: 4096,
    cssCodeSplit: false,
    sourcemap: false,
    chunkSizeWarningLimit: 1600,
    rollupOptions: {
      output: {
        manualChunks: {
          phaser: ['phaser'],
        },
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
    strictPort: false,
  },
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
  },
} as any);
