/* ==========================================================================
   sw.js —— 星虹巢·写作间 service worker
   --------------------------------------------------------------------------
   只缓存 app shell（HTML / JS / CSS / manifest / 图标）。
   /api/* 一律 network-only：写作间的内容永远以线上为准，缓存了反而会写错东西。

   缓存策略：
     · 导航请求：先走网络，断网时回退到缓存的 index.html（离线也能开壳）
     · app shell 文件（js/css/manifest）：先网络，失败用缓存（保证拿到新代码）
     · 图标：先缓存（基本不变）
   ========================================================================== */

const VERSION = 'blogstand-mobile-v2';
const CACHE = 'shell-' + VERSION;

// Fugue 界面图标（32×32 PNG，按 16px 显示），和 app.js 的 FUGUE 映射表一一对应。
// 换图标 / 加图标时这里要同步，否则第一次离线打开会少图。
const FUGUE_ICONS = [
  'arrow-180-small',
  'arrow-000-small',
  'pencil',
  'book',
  'document-text',
  'balloon-quotation',
  'image',
  'arrow-repeat',
  'paper-plane',
  'cross',
  'diamond',
  'tick',
  'eye',
  'calendar',
  'external',
];

const SHELL = [
  '/',
  '/index.html',
  '/app.js',
  '/style.css',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
  ...FUGUE_ICONS.map((name) => `/icons/fugue/${name}.png`),
];

// 这几个走「网络优先」：改版后能立刻拿到新文件
const NETWORK_FIRST = new Set([
  '/index.html',
  '/app.js',
  '/style.css',
  '/manifest.webmanifest',
]);

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // 逐个取，单个 404 不要让整个安装失败
    await Promise.all(SHELL.map(async (url) => {
      try {
        const res = await fetch(url, { cache: 'reload' });
        if (res && res.ok) await cache.put(url, res);
      } catch { /* 这个资源先不进缓存，下次运行时再补 */ }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;

  if (request.method !== 'GET') return;

  let url;
  try { url = new URL(request.url); } catch { return; }

  if (url.origin !== self.location.origin) return;

  // /api/* 和 /api 一律不碰：network-only
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return;

  // sw.js 自己也不碰，交给浏览器更新机制
  if (url.pathname === '/sw.js') return;

  // 导航：网络优先，断网回壳
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        return await fetch(request);
      } catch {
        const cache = await caches.open(CACHE);
        const shell = (await cache.match('/index.html')) || (await cache.match('/'));
        if (shell) return shell;
        return new Response('离线了，而且本地还没有存下写作间。', {
          status: 503,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      }
    })());
    return;
  }

  const path = url.pathname;

  if (NETWORK_FIRST.has(path)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        const res = await fetch(request);
        if (res && res.ok) cache.put(request, res.clone());
        return res;
      } catch {
        const hit = await cache.match(request);
        if (hit) return hit;
        return new Response('离线，资源没缓存。', {
          status: 503,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      }
    })());
    return;
  }

  // 其它同源资源（图标等）：缓存优先，顺手补进缓存
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(request);
    if (hit) return hit;
    try {
      const res = await fetch(request);
      if (res && res.ok) cache.put(request, res.clone());
      return res;
    } catch {
      return new Response('离线，资源没缓存。', {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }
  })());
});
