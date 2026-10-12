/* ============================================================
   _shared.js —— 三个公开接口 + 三个管理接口共用的东西
   ------------------------------------------------------------
   Pages Functions 里，以下划线开头的文件不会被当成路由，
   所以这个文件只当模块用，不会被外部直接请求到。

   这里放：CORS、JSON 响应、北京时间、sha256、ip_hash、
   限流读写、行 -> 前端 JSON 结构的映射。

   两条硬规矩：
     1. ip_hash / token_hash / status 绝不进公开响应；
     2. 时间一律北京时间 +08:00 字符串，不用 toISOString() 的 Z。
   ============================================================ */

export const COLORS = ['white', 'cream', 'yellow', 'pink', 'green', 'blue'];
export const BODY_MAX = 300;
export const NAME_MAX = 24;
export const REPLY_MAX = 500;

export const RATE_PER_HOUR = 5;
export const RATE_PER_DAY = 20;
export const MIN_ELAPSED_MS = 1500;   // 比这更快提交的一律当成机器人

const TZ = 'Asia/Shanghai';
const DEFAULT_SALT = 'board-default-salt-change-me';

/* ---------------- CORS ---------------- */

/* 只放行站点自己和本地预览：
     https://arcarlight.github.io        （GitHub Pages 上的正式站）
     http://127.0.0.1:任意端口 / http://localhost:任意端口   （本地看效果）
   其它来源不回 ACAO，浏览器自己会拦下来。 */
export function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  const h = new Headers();
  if (
    origin === 'https://arcarlight.github.io' ||
    /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)
  ) {
    h.set('Access-Control-Allow-Origin', origin);
    h.set('Vary', 'Origin');
  }
  h.set('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  h.set('Access-Control-Allow-Headers', 'content-type,x-board-token');
  h.set('Access-Control-Max-Age', '86400');
  return h;
}

export function preflight(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

export function json(request, status, obj) {
  const h = corsHeaders(request);
  h.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(obj), { status, headers: h });
}

export function fail(request, status, error) {
  return json(request, status, { ok: false, error });
}

/* 管理接口的钥匙。token 不对就说「unauthorized」，不透露任何细节。 */
export function isAdmin(request, env) {
  const want = (env && env.ADMIN_TOKEN) || '';
  const got = request.headers.get('x-board-token') || '';
  if (!want || !got) return false;
  if (want.length !== got.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}

export function unauthorized(request) {
  return fail(request, 401, 'unauthorized');
}

/* ---------------- 时间（北京时间） ---------------- */

let cnFmt = null;

function cnParts(d) {
  if (!cnFmt) {
    cnFmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: TZ,
      hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
  }
  const out = {};
  for (const p of cnFmt.formatToParts(d)) out[p.type] = p.value;
  // 某些 ICU 版本把午夜给成 24，统一压回 00
  if (out.hour === '24') out.hour = '00';
  return out;
}

/* 'YYYY-MM-DDTHH:MM:SS+08:00' */
export function nowCN(d = new Date()) {
  const p = cnParts(d);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}+08:00`;
}

/* 'YYYY-MM-DDTHH'，小时桶用 */
function hourBucket(d) {
  const p = cnParts(d);
  return `${p.year}-${p.month}-${p.day}T${p.hour}`;
}

/* 'YYYY-MM-DD'，天桶用 */
function dayBucket(d) {
  const p = cnParts(d);
  return `${p.year}-${p.month}-${p.day}`;
}

/* ---------------- 哈希 / 客户端标识 ---------------- */

const enc = new TextEncoder();

export async function sha256Hex(input) {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(String(input)));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function saltOf(env) {
  const s = (env && env.IP_SALT) || '';
  return s || DEFAULT_SALT;
}

/* 只留 IP 的哈希前 16 位，原始 IP 不落库、不打日志 */
export async function ipHashOf(request, env) {
  const ip =
    request.headers.get('CF-Connecting-IP') ||
    (request.headers.get('X-Forwarded-For') || '').split(',')[0].trim() ||
    (request.headers.get('X-Real-IP') || '') ||
    '0.0.0.0';
  const full = await sha256Hex(ip + '|' + saltOf(env));
  return full.slice(0, 16);
}

/* ---------------- 限流 ---------------- */

/* 读当前小时桶/天桶的计数，[] 表示放行 */
export async function checkRate(db, ipHash, now = new Date()) {
  const rows = await db
    .prepare('SELECT bucket, n FROM rate WHERE ip_hash = ? AND bucket IN (?, ?)')
    .bind(ipHash, 'h:' + hourBucket(now), 'd:' + dayBucket(now))
    .all();
  const got = {};
  for (const r of rows.results || []) got[r.bucket] = r.n;
  const hour = got['h:' + hourBucket(now)] || 0;
  const day = got['d:' + dayBucket(now)] || 0;
  if (hour >= RATE_PER_HOUR) return '发得太快了，一小时最多 5 张，歇一会儿再来。';
  if (day >= RATE_PER_DAY) return '今天贴得够多了，一天最多 20 张，明天再来。';
  return '';
}

/* 发成功后计数 +1；顺手清掉本 IP 两天前的旧桶，别让表一直长 */
export async function bumpRate(db, ipHash, now = new Date()) {
  await db.batch([
    db
      .prepare('INSERT INTO rate (ip_hash, bucket, n) VALUES (?, ?, 1) ON CONFLICT(ip_hash, bucket) DO UPDATE SET n = n + 1')
      .bind(ipHash, 'h:' + hourBucket(now)),
    db
      .prepare('INSERT INTO rate (ip_hash, bucket, n) VALUES (?, ?, 1) ON CONFLICT(ip_hash, bucket) DO UPDATE SET n = n + 1')
      .bind(ipHash, 'd:' + dayBucket(now)),
    db
      .prepare("DELETE FROM rate WHERE ip_hash = ? AND substr(bucket, 3) < ?")
      .bind(ipHash, dayBucket(new Date(now.getTime() - 2 * 86400 * 1000)))
  ]);
}

/* ---------------- 行 -> JSON ---------------- */

/* 公开版：给了 includeStatus 就多带一个 status（管理列表用）。
   reply 为空时给 null，前端按 null 判断有没有回复。 */
export function toNote(row, includeStatus = false) {
  const n = {
    id: row.id,
    name: row.name || '',
    color: row.color || 'white',
    body: row.body || '',
    at: row.created_at || '',
    reply: row.reply_body
      ? { by: '虹星', body: row.reply_body, at: row.reply_at || '' }
      : null
  };
  if (includeStatus) n.status = row.status || 'visible';
  return n;
}

export function noteById(db, id) {
  return db
    .prepare('SELECT id, created_at, name, color, body, status, reply_body, reply_at FROM notes WHERE id = ?')
    .bind(id)
    .first();
}

/* ---------------- 请求体 ---------------- */

/* 脏 JSON 不抛异常，一律当成 {} 走后面的字段校验 */
export async function readJson(request) {
  try {
    const v = await request.json();
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch (e) {
    return {};
  }
}

/* 只收允许的长度，别让 limit=1e9 或者 limit=abc 打到 D1 */
export function clampLimit(raw, def, max) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(n, max);
}

export function normalizeColor(c) {
  return COLORS.includes(c) ? c : 'white';
}

export function cleanText(v, max) {
  return String(v == null ? '' : v).trim().slice(0, max);
}
