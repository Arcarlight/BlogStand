/* ============================================================
   /cdn/* —— 素材仓库的代理（把 raw.githubusercontent 搬到 Cloudflare 边缘）
   ------------------------------------------------------------
   为什么需要它：
     素材本体在 GitHub 私有仓库外的独立仓库
     （Arcarlight/Nijiboshi-Giveout-Storage），直接给页面用
     raw.githubusercontent.com 在部分网络下打不开；
     jsDelivr 对这个仓库又会 301 转回 raw（实测时好时坏）。
     走自己的 Worker：浏览器 → Cloudflare 边缘（本函数）→ GitHub raw，
     对访客来说永远是同一个域、永远能开。

   用法：GET /cdn/<素材仓库里的相对路径>
     例：/cdn/tbtak/sprite/Fliegen-sprite-cut.png

   只允许三个白名单前缀，避免被当成任意网址代理：
     tbtak/sprite/ · tbtak/portrait/ · tbtak/ui/ · audio/midi/
   ============================================================ */

const REPO = 'Arcarlight/Nijiboshi-Giveout-Storage';
const BRANCH = 'main';
const RAW = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/`;

/* 只放行素材目录，别把它变成万能代理 */
const ALLOW = /^(tbtak\/(sprite|portrait|ui)|audio\/midi)\//;

const TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  mid: 'audio/midi',
  midi: 'audio/midi',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  zip: 'application/zip',
  txt: 'text/plain; charset=utf-8',
  json: 'application/json; charset=utf-8',
};

function typeOf(path) {
  const ext = (path.split('.').pop() || '').toLowerCase();
  return TYPES[ext] || 'application/octet-stream';
}

function deny(status, msg) {
  return new Response(msg, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export async function onRequestGet({ request, params }) {
  /* [[path]] 可能是数组也可能是字符串，两种都兜住 */
  const seg = Array.isArray(params.path) ? params.path : String(params.path || '').split('/');
  const rel = seg.filter(Boolean).join('/');

  if (!rel) return deny(400, 'missing path');
  if (rel.includes('..') || !ALLOW.test(rel)) return deny(403, 'forbidden');

  const url = RAW + rel;
  let r;
  try {
    /* cacheEverything + 长 TTL：GitHub 那边只被打一次，之后都在 Cloudflare 边缘 */
    r = await fetch(url, { cf: { cacheEverything: true, cacheTtl: 86400 } });
  } catch (e) {
    return deny(502, 'upstream fetch failed: ' + String((e && e.message) || e));
  }
  if (!r.ok) return deny(r.status === 404 ? 404 : 502, 'upstream ' + r.status);

  return new Response(r.body, {
    status: 200,
    headers: {
      'Content-Type': typeOf(rel),
      /* 素材按文件名当版本：同名覆盖时 jsDelivr / 我们的缓存都可能还旧的，
         所以叫大家发新版本就换文件名（见 .notes/素材分发.md） */
      'Cache-Control': 'public, max-age=86400',
      'Access-Control-Allow-Origin': '*',
      'X-Asset-Path': rel,
    },
  });
}
