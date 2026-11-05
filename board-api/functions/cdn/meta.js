/* ============================================================
   /cdn/meta —— 批量问「这些素材各多大」
   ------------------------------------------------------------
   素材分发页要在卡片上显示文件大小，但那个数字**不该由站长维护**。
   页面把当前列出的文件一次性 POST 过来，这里回一份 { 路径: 字节数 }。

   · 走的是同一个 GitHub raw 源（和 /cdn/* 反代一致），Cloudflare 边缘缓存一天；
   · 只放行素材目录，和 /cdn/* 用同一份白名单；
   · HEAD 拿 content-length；GitHub raw 要是不给 HEAD 就退回 GET，拿完头就把 body 取消。

   尺寸（宽×高）不在这里算 —— 图片加载完浏览器自己就知道 naturalWidth/Height。
   ============================================================ */

const REPO = 'Arcarlight/Nijiboshi-Giveout-Storage';
const BRANCH = 'main';
const RAW = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/`;

const ALLOW = /^(tbtak\/(sprite|portrait|ui)|audio\/midi)\//;
const MAX_FILES = 300;

function cors() {
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'content-type',
  };
}

async function sizeOf(rel) {
  const url = RAW + rel;
  const opts = { cf: { cacheEverything: true, cacheTtl: 86400 } };
  try {
    let r = await fetch(url, Object.assign({ method: 'HEAD' }, opts));
    if (r.ok) {
      const n = Number(r.headers.get('content-length') || 0);
      if (n) return n;
    }
    r = await fetch(url, opts);
    if (!r.ok) return 0;
    const n = Number(r.headers.get('content-length') || 0);
    /* 只要头，别把整个文件拉完 */
    try { if (r.body) await r.body.cancel(); } catch (e) { /* 取消失败无所谓 */ }
    return n;
  } catch (e) {
    return 0;
  }
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: cors() });
}

export async function onRequestPost({ request }) {
  let body = null;
  try { body = await request.json(); } catch (e) { body = null; }
  const files = Array.isArray(body && body.files) ? body.files.slice(0, MAX_FILES) : [];
  const out = {};

  await Promise.all(files.map(async (f) => {
    const rel = String(f || '').replace(/^\/+/, '');
    if (!rel || rel.includes('..') || !ALLOW.test(rel)) return;
    out[rel] = await sizeOf(rel);
  }));

  return new Response(JSON.stringify({ ok: true, bytes: out }), { status: 200, headers: cors() });
}

export async function onRequestGet({ request }) {
  const url = new URL(request.url);
  const rel = String(url.searchParams.get('p') || '').replace(/^\/+/, '');
  if (!rel || rel.includes('..') || !ALLOW.test(rel)) {
    return new Response(JSON.stringify({ ok: false, error: 'forbidden' }), { status: 403, headers: cors() });
  }
  const n = await sizeOf(rel);
  return new Response(JSON.stringify({ ok: !!n, bytes: n }), { status: 200, headers: cors() });
}
