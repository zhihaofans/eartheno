/* eslint-disable no-undef */
/**
 * 地髓 Eartheno — Service Worker
 *
 * 设计取舍（都来自经验文档 §7、§11 的踩坑记录）：
 * ① 缓存名带 BUILD 号，activate 时只清「同前缀的旧版本」，不碰同域其它应用的缓存。
 * ② 预缓存逐个 add().catch()，一个资源 404 不能拖垮整个安装（否则离线直接失效）。
 * ③ 导航请求走 network-first：联网时永远拿最新 HTML（避免"更新了但打开还是旧的"），
 *    断网时回落到缓存的 index.html。
 * ④ 静态资源走 stale-while-revalidate：首屏快，后台悄悄换新。
 * ⑤ 绝不 cache.addAll() 一个不存在的 manifest / 图标路径 —— 安装失败会让 SW 反复重试。
 */
const BUILD = '20261018-1752-cazc';
const CACHE_PREFIX = 'eartheno-';
const CACHE_NAME = `${CACHE_PREFIX}${BUILD}`;

/** 构建时由 tools/postbuild.mjs 注入成实际文件列表 —— 见 ../dist/precache.json */
const PRECACHE = [
  "./assets/index-CjizlZQO.js",
  "./assets/phaser-0YPJO2g1.js",
  "./assets/style-BgU-1fxP.css",
  "./icons/apple-180.png",
  "./icons/favicon-32.png",
  "./icons/icon-192.png",
  "./icons/icon-512-maskable.png",
  "./icons/icon-512.png",
  "./icons/icon.svg",
  "./icons/shot-landscape.png",
  "./index.html",
  "./manifest.webmanifest"
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await Promise.all(
        PRECACHE.map((url) =>
          cache.add(new Request(url, { cache: 'reload' })).catch((err) => {
            // 单个资源失败不影响整体安装；离线时缺这一张图/这一个音效而已
            console.warn('[sw] precache miss', url, err && err.message);
          }),
        ),
      );
      // 新 SW 立即进入 waiting，由页面提示用户刷新（不自动 skipWaiting —— 会打断正在玩的局）
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE_NAME)
          .map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 跨域资源交给浏览器默认策略

  // 导航：network-first，断网回落 index.html
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req);
          const cache = await caches.open(CACHE_NAME);
          cache.put(req, fresh.clone()).catch(() => {});
          return fresh;
        } catch {
          const cache = await caches.open(CACHE_NAME);
          const cached = (await cache.match(req)) || (await cache.match('./index.html')) || (await cache.match('index.html'));
          if (cached) return cached;
          return new Response('离线且没有缓存', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
        }
      })(),
    );
    return;
  }

  // 版本文件永远走网络（离线时给个空壳，避免页面卡在"检查更新"）
  if (url.pathname.endsWith('/version.json')) {
    event.respondWith(fetch(req).catch(() => new Response('{}', { headers: { 'Content-Type': 'application/json' } })));
    return;
  }

  // 静态资源：stale-while-revalidate
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(req);
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
          return res;
        })
        .catch(() => null);
      if (cached) {
        event.waitUntil(network.then(() => {}));
        return cached;
      }
      const res = await network;
      if (res) return res;
      return new Response('', { status: 504 });
    })(),
  );
});
