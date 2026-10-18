import { defineConfig, devices } from '@playwright/test';

/**
 * E2E 跑在 **构建产物** 上（vite preview），不是 dev server ——
 * 因为要验证的很大一部分是 PWA / Service Worker / 相对路径部署，
 * 这些在 dev 下行为完全不同，测了也没意义。
 *
 * 端口特意用 4319，避开 `npm run preview` 默认的 4173，
 * 免得本地开着预览时 E2E 连到旧产物上。
 */
const PORT = 4319;

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 45_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  // 存档 / SW 都是全局状态，多个 worker 并行会互相污染
  workers: 1,
  // CI 上给 2 次重试：runner 冷启动时首帧极慢（下载 chromium、解压、首次 JIT），
  // 少数"等 1 秒内必须发生"的交互会偶发超时。这是环境抖动，不是功能回归。
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    // 手机横屏：844×390 ≈ iPhone 12/13 横过来
    viewport: { width: 844, height: 390 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    actionTimeout: 10_000,
    trace: process.env.CI ? 'retain-on-failure' : 'off',
  },
  projects: [
    {
      name: 'mobile-landscape',
      use: { ...devices['Pixel 5'], viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
    },
  ],
  webServer: {
    command: `npx vite preview --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
