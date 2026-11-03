/* ============================================================
   /api/hits —— 自建访客计数（替代不蒜子）
   ------------------------------------------------------------
     GET ?p=/blog/xxx/&v=<访客随机 id>
       → { ok, site_uv, site_pv, page_pv, counted }

   为什么要自己搞：busuanzi.ibruce.info 的统计接口经常 502 抽风
   （2026-11-03 实测 90 秒里 4 次 502），而且第三方停服没预告。
   数字现在存在自己的 D1 里，表格见 schema.sql 的 hits / visitors。

   两条硬规矩（跟布告栏一致）：
     1. 原始 IP、原始浏览器 id 都不落库，visitors 只存 sha256 前 16 位；
     2. 计数失败不影响页面 —— 前端拿不到数字就显示上次缓存的。

   防刷：同一个 UA 里带 bot/crawl/curl 之类的不计数（只读数字），
   免得爬虫把 UV 刷成天文数字。
   ============================================================ */

import { corsHeaders, fail, nowCN, preflight, saltOf, sha256Hex } from './_shared.js';

const PATH_MAX = 200;
const VID_MAX = 64;

/* 常见的爬虫 / 预览 UA。命中就只返回数字，不 +1 */
const BOT = /bot|crawl|spider|slurp|headless|preview|facebookexternalhit|curl|wget|python-requests|httpclient/i;

/* 路径统一：去掉 query/hash、补开头斜杠、压掉重复斜杠、**补尾斜杠**
   （/blog/x 和 /blog/x/ 必须是同一个 key，否则同一页会被记成两条） */
function cleanPath(raw) {
  let s = String(raw || '').split('?')[0].split('#')[0].trim();
  if (!s.startsWith('/')) s = '/' + s;
  s = s.replace(/\/{2,}/g, '/');
  if (!s.endsWith('/')) s += '/';
  if (s.length > PATH_MAX) s = s.slice(0, PATH_MAX);
  return s;
}

function noStore(request, obj) {
  const h = corsHeaders(request);
  h.set('Content-Type', 'application/json; charset=utf-8');
  h.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify(obj), { status: 200, headers: h });
}

export async function onRequestOptions({ request }) {
  return preflight(request);
}

export async function onRequestGet({ request, env }) {
  if (!env || !env.DB) return fail(request, 503, 'database not bound');

  const url = new URL(request.url);
  const path = cleanPath(url.searchParams.get('p'));
  const vid = String(url.searchParams.get('v') || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, VID_MAX);
  const ua = request.headers.get('user-agent') || '';
  const counted = !!vid && !BOT.test(ua);
  const now = nowCN();

  try {
    let vh = '';
    if (counted) {
      await env.DB.prepare(
        'INSERT INTO hits (path, pv, updated_at) VALUES (?, 1, ?) ' +
        'ON CONFLICT(path) DO UPDATE SET pv = pv + 1, updated_at = excluded.updated_at'
      ).bind(path, now).run();

      /* 访客去重：同一个浏览器 id 永远只算一次 UV。
         INSERT OR IGNORE + 不读插入结果 = 一次写就好，不用再查。 */
      vh = (await sha256Hex(vid + '|' + saltOf(env))).slice(0, 16);
      await env.DB.prepare('INSERT OR IGNORE INTO visitors (vid, at) VALUES (?, ?)')
        .bind(vh, now).run();

      /* 常客：按 (访客, 北京时间日期) 记一天来几次，回头客靠它算 */
      await env.DB.prepare(
        'INSERT INTO visitor_days (vid, day, n) VALUES (?, ?, 1) ' +
        'ON CONFLICT(vid, day) DO UPDATE SET n = n + 1'
      ).bind(vh, now.slice(0, 10)).run();
    }

    const [sitePv, pagePv, siteUv, regular, base] = await Promise.all([
      env.DB.prepare('SELECT COALESCE(SUM(pv), 0) AS n FROM hits').first(),
      env.DB.prepare('SELECT COALESCE(pv, 0) AS n FROM hits WHERE path = ?').bind(path).first(),
      env.DB.prepare('SELECT COUNT(*) AS n FROM visitors').first(),
      /* 「常客」= 来过 ≥2 个不同日子的人 */
      env.DB.prepare(
        'SELECT COUNT(*) AS n FROM (' +
        '  SELECT vid FROM visitor_days GROUP BY vid HAVING COUNT(*) >= 2' +
        ')'
      ).first(),
      env.DB.prepare('SELECT key, value FROM baseline').all(),
    ]);

    /* 这一位访客自己来过几次（没有计数就不查） */
    let selfVisits = 0;
    if (vh) {
      const sv = await env.DB
        .prepare('SELECT COALESCE(SUM(n), 0) AS n FROM visitor_days WHERE vid = ?')
        .bind(vh).first();
      selfVisits = Number((sv && sv.n) || 0);
    }

    /* baseline：从 不蒜子 迁过来的历史值（见 schema.sql）。
       页面上的数 = 历史基准 + 本系统之后记到的数。 */
    const b = {};
    for (const row of ((base && base.results) || [])) b[row.key] = Number(row.value) || 0;

    return noStore(request, {
      ok: true,
      site_uv: (b.site_uv || 0) + Number((siteUv && siteUv.n) || 0),
      site_pv: (b.site_pv || 0) + Number((sitePv && sitePv.n) || 0),
      page_pv: Number((pagePv && pagePv.n) || 0),
      site_regular: Number((regular && regular.n) || 0),
      self_visits: selfVisits,
      counted,
    });
  } catch (e) {
    /* 表还没建 / D1 抽风：别把计数错误变成页面错误，返回一个可读的原因 */
    return noStore(request, { ok: false, error: String((e && e.message) || e).slice(0, 200) });
  }
}
