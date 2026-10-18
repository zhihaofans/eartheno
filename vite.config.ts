import { defineConfig } from 'vite';

/**
 * 部署路径（base）的决定逻辑 —— 这里踩过一次，记清楚：
 *
 * `base: './'`（相对路径）在「项目页 /<仓库名>/」和「根路径 /」下都能跑，
 * 实测过子目录、无尾斜杠、显式 index.html、离线重开四种场景都正常。
 * SW 注册用的是 `new URL('sw.js', document.baseURI)`，天然跟随 base。
 *
 * 但相对路径有一个真实隐患：**任何深层 URL**（例如 SPA 回退后的 /repo/a/b/）
 * 都会把 './assets' 解析到 /repo/a/b/assets，直接 404。
 * GitHub Pages 不做 SPA 回退，本项目也不会产生深层 URL，所以目前是安全的；
 * 但如果哪天加了路由，务必切到绝对路径。
 *
 * 因此留了一个显式开关：设 `GHP_BASE=/仓库名/` 就用绝对路径，最稳。
 *
 *   npm run build                      → base './'（相对，任意子目录可用）
 *   GHP_BASE=/eartheno/ npm run build  → base '/eartheno/'（GitHub 项目页，绝对路径）
 */
const base = process.env.GHP_BASE || './';

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
