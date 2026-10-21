/* ============================================================
   mobile-editor / functions/api/_shared.js
   ------------------------------------------------------------
   后端共用模块。文件以 _ 开头，Pages 不会把它当路由。

   这里放：
     - 统一 JSON 响应 / 错误（HttpError）
     - 读请求体（带体积上限）
     - base64 / SHA-256 / HMAC / 常量时间比较
     - 北京时间
     - front matter 解析 + lastmod 刷新（契约 §3.1）
     - 路径白名单（契约 §2）
     - GitHub 封装：读文件 / git tree / Git Data API 原子多文件提交（契约 §2）
     - 日记小节定位与插入（契约 §3.3）
     - 布告栏后端转发

   运行环境是 Workers（V8 isolate）：没有 Node API，不用 Buffer/fs/process。
   ============================================================ */

/* ============================================================
   0. 错误 + JSON 响应
   ============================================================ */

export class HttpError extends Error {
  /**
   * @param {number} status HTTP 状态码
   * @param {string} message 会原样放进 {error: message}
   * @param {object|null} extra 额外字段（比如 409 冲突时的 {sha, text}）
   */
  constructor(status, message, extra = null) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.extra = extra;
  }
}

export function json(obj, status = 200, extraHeaders = null) {
  const headers = new Headers();
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'no-store');
  headers.set('x-robots-tag', 'noindex');
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) headers.set(k, v);
  }
  return new Response(JSON.stringify(obj), { status, headers });
}

/** 把任意异常变成 JSON 响应；GitHub 的 message 会原样透出（契约 §2） */
export function errorToResponse(e) {
  if (e instanceof HttpError) {
    return json(Object.assign({ error: e.message }, e.extra || {}), e.status);
  }
  const msg = e && e.message ? String(e.message) : '服务器内部错误';
  return json({ error: msg }, 500);
}

/* ============================================================
   1. 请求体
   ============================================================ */

/**
 * 读 JSON 请求体。
 * - 先看 content-length，再按实际文本长度兜底（避免没有 content-length 的请求绕过）
 * - 超过上限抛 413
 * - 空体返回 {}
 * - 非法 JSON 抛 400
 */
export async function readJsonBody(request, maxBytes = 1_000_000, tooLargeMessage = '') {
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared && declared > maxBytes) {
    throw new HttpError(413, tooLargeMessage || `请求体太大，最多 ${Math.floor(maxBytes / 1024 / 1024)}MB`);
  }
  let text = '';
  try {
    text = await request.text();
  } catch (e) {
    throw new HttpError(400, '请求体读不出来');
  }
  if (text.length > maxBytes) {
    throw new HttpError(413, tooLargeMessage || `请求体太大，最多 ${Math.floor(maxBytes / 1024 / 1024)}MB`);
  }
  if (!text.trim()) return {};
  let value;
  try {
    value = JSON.parse(text);
  } catch (e) {
    throw new HttpError(400, '请求体不是合法 JSON');
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/* ============================================================
   2. 编码 / 哈希
   ============================================================ */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8');

export function utf8Encode(str) {
  return textEncoder.encode(String(str));
}

export function utf8Decode(bytes) {
  return textDecoder.decode(bytes);
}

export function bytesToBase64(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < arr.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, arr.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function base64ToBytes(b64) {
  const clean = String(b64 == null ? '' : b64).replace(/^data:[^;]+;base64,/, '').replace(/\s+/g, '');
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64Url(bytes) {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function sha256Hex(input) {
  const buf = await crypto.subtle.digest('SHA-256', utf8Encode(String(input)));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function hmacSha256Base64Url(secret, msg) {
  const key = await crypto.subtle.importKey(
    'raw',
    utf8Encode(String(secret)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, utf8Encode(String(msg)));
  return bytesToBase64Url(new Uint8Array(sig));
}

/**
 * 常量时间字符串比较：长度不同也照样走完整循环，最后把长度差并入结果。
 * 用于 cookie 签名（契约 §1）和口令哈希比较。
 */
export function timingSafeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const max = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < max; i++) {
    const ca = i < a.length ? a.charCodeAt(i) : 0;
    const cb = i < b.length ? b.charCodeAt(i) : 0;
    diff |= ca ^ cb;
  }
  return diff === 0;
}

/** SHA-256(输入口令) 与 SHA-256(env.EDITOR_PASS) 常量时间比较（契约 §1） */
export async function verifyEditorPass(env, pass) {
  const got = await sha256Hex(pass == null ? '' : String(pass));
  const want = await sha256Hex(String(env.EDITOR_PASS || ''));
  return timingSafeEqualStr(got, want);
}

/* ============================================================
   2.5 认证 cookie（契约 §1）
   ============================================================ */

export const SESSION_COOKIE = 'be_sess';
export const SESSION_MAX_AGE = 2592000; // 30 天

/** 'a=1; b=2' -> {a:'1', b:'2'} */
export function parseCookies(header) {
  const out = {};
  const raw = String(header || '');
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

/** Set-Cookie 头；maxAge <= 0 表示清掉 */
export function sessionCookieHeader(value, maxAge = SESSION_MAX_AGE) {
  return `${SESSION_COOKIE}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${Math.max(0, maxAge)}`;
}

/** 生成新会话 cookie 值：<exp>.<base64url(HMAC-SHA256(secret, exp))> */
export async function createSessionValue(env) {
  if (!env.SESSION_SECRET) throw new HttpError(500, '服务端还没配置 SESSION_SECRET');
  const exp = String(Math.floor(Date.now() / 1000) + SESSION_MAX_AGE);
  const sig = await hmacSha256Base64Url(env.SESSION_SECRET, exp);
  return `${exp}.${sig}`;
}

/** 校验请求里的 be_sess；通过返回 true */
export async function verifySession(request, env) {
  if (!env || !env.SESSION_SECRET) return false;
  const raw = parseCookies(request.headers.get('cookie'))[SESSION_COOKIE];
  if (!raw) return false;
  const dot = raw.lastIndexOf('.');
  if (dot <= 0) return false;
  const exp = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  if (!/^\d+$/.test(exp)) return false;
  if (Number(exp) * 1000 <= Date.now()) return false;
  let want;
  try {
    want = await hmacSha256Base64Url(env.SESSION_SECRET, exp);
  } catch (e) {
    return false;
  }
  return timingSafeEqualStr(want, sig);
}

/* ============================================================
   3. 北京时间
   ============================================================ */

const TZ = 'Asia/Shanghai';
let cnDateFmt = null;

function beijingDateParts(d = new Date()) {
  if (!cnDateFmt) {
    cnDateFmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  }
  const out = {};
  for (const p of cnDateFmt.formatToParts(d)) out[p.type] = p.value;
  return out;
}

/** 'YYYY-MM-DD'（UTC+8） */
export function beijingDate(d = new Date()) {
  const p = beijingDateParts(d);
  return `${p.year}-${p.month}-${p.day}`;
}

export function pad2(n) {
  return String(n).padStart(2, '0');
}

export function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/* ============================================================
   4. front matter（契约 §3.1）
   ============================================================ */

/**
 * 拆 front matter。
 * 返回 null 表示没有 front matter；否则：
 *   { prefixLen, closeStart, bodyStart, fmText, body, eol }
 * bodyStart 之后就是正文（含闭合 --- 行后的换行）。
 */
export function splitFrontMatter(text) {
  if (typeof text !== 'string') return null;
  const first = text.match(/^---[ \t]*\r?\n/);
  if (!first) return null;
  const rest = text.slice(first[0].length);
  const close = rest.match(/^---[ \t]*(?:\r?\n|$)/m);
  if (!close) return null;
  const closeStart = first[0].length + close.index;
  const fmText = rest.slice(0, close.index);
  const bodyStart = closeStart + close[0].length;
  return {
    prefixLen: first[0].length,
    closeStart,
    bodyStart,
    fmText,
    body: text.slice(bodyStart),
    eol: text.includes('\r\n') ? '\r\n' : '\n',
  };
}

function unquoteYaml(v) {
  let s = String(v == null ? '' : v).trim();
  if (!s) return '';
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    s = s.slice(1, -1);
    try {
      // YAML 双引号串大部分是合法 JSON 转义；转不了就退回原样
      return JSON.parse('"' + s.replace(/\\'/g, "'") + '"');
    } catch (e) {
      return s;
    }
  }
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) return s.slice(1, -1);
  return s;
}

/** 只解析列表页需要的几个字段，不做完整 YAML */
export function parseFrontMatter(text) {
  const fm = splitFrontMatter(text);
  const out = { hasFm: !!fm, title: '', date: '', draft: false, lastmod: '', body: text, fields: {} };
  if (!fm) return out;
  out.body = fm.body;
  const lines = fm.fmText.split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    const value = m[2];
    out.fields[key] = value;
    if (key === 'title') out.title = unquoteYaml(value);
    else if (key === 'date') out.date = unquoteYaml(value);
    else if (key === 'lastmod') out.lastmod = unquoteYaml(value);
    else if (key === 'draft') out.draft = /^true$/i.test(String(value).trim());
  }
  return out;
}

/** 把 lastmod 写成不加引号的 YYYY-MM-DD；没有就加在 front matter 末尾 */
function setLastmod(text, date) {
  const fm = splitFrontMatter(text);
  if (!fm) return text;
  const eol = fm.eol;
  const lines = fm.fmText.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const idx = lines.findIndex((l) => /^lastmod\s*:/.test(l));
  if (idx >= 0) lines[idx] = `lastmod: ${date}`;
  else lines.push(`lastmod: ${date}`);
  const fmOut = lines.join(eol) + eol;
  return text.slice(0, fm.prefixLen) + fmOut + text.slice(fm.closeStart);
}

/**
 * 保存 content/*.md 时：正文（front matter 之后的部分）变了才把 lastmod 刷成今天。
 * 正文没变就原样返回。没有 front matter 的文件不动（没法安全地凭空加一个）。
 */
export function touchLastmod(oldText, newText) {
  const oldBody = splitFrontMatter(oldText || '')?.body ?? (oldText || '');
  const newBody = splitFrontMatter(newText || '')?.body ?? (newText || '');
  if (oldBody === newBody) return newText;
  return setLastmod(newText, beijingDate());
}

/* ============================================================
   5. 路径白名单（契约 §2）
   ============================================================ */

const IMAGE_PATH_RE = /^static\/images\/[A-Za-z0-9._/-]+$/;
const MUSIC_PATH_RE = /^static\/music\/[A-Za-z0-9._/-]+$/;

function pathSegmentsOk(path) {
  if (typeof path !== 'string' || !path) return false;
  if (path.includes('\\') || path.includes('\u0000')) return false;
  if (path.startsWith('/')) return false;
  const segs = path.split('/');
  for (const s of segs) {
    if (s === '' || s === '.' || s === '..') return false;
  }
  return true;
}

/**
 * 只允许写：content/（.md）、static/images/、static/music/。
 * 其余（含 ..、绝对路径、反斜杠、别的目录）一律 400 {error:"路径不允许"}。
 */
export function assertWritablePath(path) {
  if (!pathSegmentsOk(path)) throw new HttpError(400, '路径不允许');
  if (path.startsWith('content/')) {
    if (!path.endsWith('.md')) throw new HttpError(400, '路径不允许');
    return path;
  }
  if (IMAGE_PATH_RE.test(path) || MUSIC_PATH_RE.test(path)) return path;
  throw new HttpError(400, '路径不允许');
}

/** 读文件沿用同一套白名单：前端只会读 content/ 下的文章 */
export function assertReadablePath(path) {
  return assertWritablePath(path);
}

/** 文件名清洗：去空格、禁 \/:*?"<>|（契约 §4 /api/new） */
export function sanitizeFileName(name) {
  return String(name == null ? '' : name)
    .trim()
    .replace(/\s+/g, '')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/^\.+/, '');
}

/** 路径里每一段单独编码，保留 / */
export function encodeRepoPath(path) {
  return String(path)
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/');
}

/* ============================================================
   6. GitHub（契约 §2）
   ============================================================ */

const GITHUB_TIMEOUT_MS = 20000;
const USER_AGENT = 'blogstand-mobile-editor';

/* ---------- /api/list 的内存缓存（见 list.js） ----------
   放在这里而不是 list.js：commitFiles 写成功后要清掉它，
   而 commitFiles 就在本文件里，反向 import list.js 会成环。 */
export const listCache = new Map();

/** 写入成功后清空列表缓存，避免「刚发的文章列表里看不到」（最多旧 5 分钟） */
export function invalidateListCache() {
  listCache.clear();
}

export function ghConfig(env) {
  const token = String((env && env.GITHUB_TOKEN) || '').trim();
  if (!token) throw new HttpError(500, '服务端还没配置 GITHUB_TOKEN');
  return {
    token,
    repo: String((env && env.GITHUB_REPO) || 'Arcarlight/BlogStand').trim(),
    branch: String((env && env.GITHUB_BRANCH) || 'main').trim(),
    api: String((env && env.GITHUB_API) || 'https://api.github.com').replace(/\/+$/, ''),
  };
}

function branchPath(branch) {
  return String(branch).split('/').map((s) => encodeURIComponent(s)).join('/');
}

export async function ghFetch(env, path, init = {}) {
  const cfg = ghConfig(env);
  const headers = Object.assign(
    {
      Authorization: `Bearer ${cfg.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': USER_AGENT,
    },
    init.body ? { 'content-type': 'application/json' } : {},
    init.headers || {}
  );
  let res;
  try {
    res = await fetch(cfg.api + path, {
      method: init.method || 'GET',
      body: init.body,
      headers,
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
  } catch (e) {
    const why = e && e.name === 'TimeoutError' ? '超时' : (e && e.message) || '网络错误';
    throw new HttpError(502, `GitHub 请求失败: ${why}`);
  }
  return res;
}

async function ghJsonFromRes(res) {
  let text = '';
  try {
    text = await res.text();
  } catch (e) {
    text = '';
  }
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (e) {
      data = null;
    }
  }
  if (!res.ok) {
    const msg = (data && data.message) || `${res.status} ${res.statusText || ''}`.trim();
    // 404 / 409 / 422 保留原状态给调用方判断，其余统一按上游故障处理
    const status = [404, 409, 422].includes(res.status) ? res.status : 502;
    throw new HttpError(status, `GitHub: ${msg}`);
  }
  return data;
}

/** 调 GitHub API 并解析 JSON；非 2xx 抛 HttpError，message 透出 */
export async function ghJson(env, path, init = {}) {
  const res = await ghFetch(env, path, init);
  return ghJsonFromRes(res);
}

/**
 * 读单个文件（Contents API）。
 * 404 不算错误：返回 {exists:false, sha:null, text:null}。
 * 大文件（>1MB）GitHub 不给 content：text 为 null，但 sha 仍然有效。
 */
export async function getFile(env, path) {
  const cfg = ghConfig(env);
  const res = await ghFetch(
    env,
    `/repos/${cfg.repo}/contents/${encodeRepoPath(path)}?ref=${encodeURIComponent(cfg.branch)}`
  );
  if (res.status === 404) return { exists: false, sha: null, text: null, path };
  const data = await ghJsonFromRes(res);
  if (Array.isArray(data)) throw new HttpError(400, '这个路径是目录，不是文件');
  let text = null;
  if (data && data.content && data.encoding === 'base64') {
    try {
      text = utf8Decode(base64ToBytes(String(data.content).replace(/\s+/g, '')));
    } catch (e) {
      text = null;
    }
  }
  return { exists: true, sha: (data && data.sha) || null, text, size: data && data.size, path };
}

/** 分支上所有 blob 路径（list 用）。注意 tree 可能被 GitHub 截断 */
export async function listTreePaths(env) {
  const cfg = ghConfig(env);
  const data = await ghJson(env, `/repos/${cfg.repo}/git/trees/${branchPath(cfg.branch)}?recursive=1`);
  const tree = (data && data.tree) || [];
  return {
    paths: tree.filter((e) => e && e.type === 'blob' && typeof e.path === 'string').map((e) => e.path),
    truncated: !!(data && data.truncated),
  };
}

function contentToBase64(content) {
  if (typeof content === 'string') return bytesToBase64(utf8Encode(content));
  if (content instanceof Uint8Array) return bytesToBase64(content);
  if (content instanceof ArrayBuffer) return bytesToBase64(new Uint8Array(content));
  if (content && content.bytes instanceof Uint8Array) return bytesToBase64(content.bytes);
  throw new HttpError(400, '文件内容类型不对');
}

/**
 * 一次提交原子写多个文件（契约 §2）：
 * ref -> commit -> tree/blobs -> tree -> commit -> patch ref
 * 冲突（409/422）时重读 ref 重试，最多 2 次；仍失败 409。
 *
 * @param {object} env
 * @param {Array<{path:string, content:string|Uint8Array}>} files
 * @param {string} message 提交信息
 * @returns {Promise<{commit:string, htmlUrl:string, files:Array<{path:string,sha:string}>}>}
 */
export async function commitFiles(env, files, message) {
  const cfg = ghConfig(env);
  if (!Array.isArray(files) || files.length === 0) throw new HttpError(400, '没有要提交的文件');

  const wanted = files.map((f) => ({
    path: assertWritablePath(f.path),
    base64: contentToBase64(f.content),
  }));
  const refPath = `/repos/${cfg.repo}/git/ref/heads/${branchPath(cfg.branch)}`;
  const patchPath = `/repos/${cfg.repo}/git/refs/heads/${branchPath(cfg.branch)}`;

  const MAX_ATTEMPTS = 3; // 首次 + 最多重试 2 次
  let lastConflict = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const ref = await ghJson(env, refPath);
      const parent = ref && ref.object && ref.object.sha;
      if (!parent) throw new HttpError(502, 'GitHub: 读不到分支最新的提交');

      const parentCommit = await ghJson(env, `/repos/${cfg.repo}/git/commits/${parent}`);
      const baseTree = parentCommit && parentCommit.tree && parentCommit.tree.sha;
      if (!baseTree) throw new HttpError(502, 'GitHub: 读不到父提交的 tree');

      const treeEntries = [];
      for (const f of wanted) {
        const blob = await ghJson(env, `/repos/${cfg.repo}/git/blobs`, {
          method: 'POST',
          body: JSON.stringify({ content: f.base64, encoding: 'base64' }),
        });
        if (!blob || !blob.sha) throw new HttpError(502, 'GitHub: 创建 blob 失败');
        treeEntries.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha });
      }

      const tree = await ghJson(env, `/repos/${cfg.repo}/git/trees`, {
        method: 'POST',
        body: JSON.stringify({ base_tree: baseTree, tree: treeEntries }),
      });
      const commit = await ghJson(env, `/repos/${cfg.repo}/git/commits`, {
        method: 'POST',
        body: JSON.stringify({
          message: String(message || 'mobile-editor: 更新'),
          tree: tree && tree.sha,
          parents: [parent],
        }),
      });
      if (!commit || !commit.sha) throw new HttpError(502, 'GitHub: 创建提交失败');

      const patchRes = await ghFetch(env, patchPath, {
        method: 'PATCH',
        body: JSON.stringify({ sha: commit.sha, force: false }),
      });
      if (patchRes.ok) {
        let patched = null;
        try {
          patched = await patchRes.json();
        } catch (e) {
          patched = null;
        }
        // 写成功：列表缓存作废（下一次 /api/list 会重新拉）
        invalidateListCache();
        return {
          commit: commit.sha,
          htmlUrl:
            commit.html_url ||
            (patched && patched.object && patched.object.url) ||
            `https://github.com/${cfg.repo}/commit/${commit.sha}`,
          files: treeEntries.map((e) => ({ path: e.path, sha: e.sha })),
        };
      }

      // 非 2xx：读 message，409/422 当成「别人刚推过」重试
      let patchData = null;
      try {
        const t = await patchRes.text();
        patchData = t ? JSON.parse(t) : null;
      } catch (e) {
        patchData = null;
      }
      if (patchRes.status === 409 || patchRes.status === 422) {
        lastConflict = new HttpError(409, '仓库刚被别人改过，请刷新重试');
        continue;
      }
      throw new HttpError(
        patchRes.status === 404 ? 404 : 502,
        `GitHub: ${(patchData && patchData.message) || patchRes.status + ' ' + (patchRes.statusText || '')}`
      );
    } catch (e) {
      // 整个流程里任何 409/422（比如 ref 刚被改、tree 过期）都重试
      if (e instanceof HttpError && (e.status === 409 || e.status === 422)) {
        lastConflict = e;
        continue;
      }
      throw e;
    }
  }

  throw lastConflict || new HttpError(409, '仓库刚被别人改过，请刷新重试');
}

/* ============================================================
   7. 日记（契约 §3.2 / §3.3 / §3.4）
   ============================================================ */

export const MONTH_INFO = {
  1: ['睦月', '新春将至 万象更新'],
  2: ['如月', '草木更生 新年到来'],
  3: ['弥生月', '万物复苏 春来花开'],
  4: ['卯月', '天高云清 雨露丰裕'],
  5: ['皐月', '云转天变 时雨时晴'],
  6: ['水無月', '雨水倾覆 日日云墨'],
  7: ['文月', '风雨飘摇 冷雨湿涟'],
  8: ['叶月', '日悬晴天 酷夏炎炎'],
  9: ['長月', '秋雨连绵 云沉满天'],
  10: ['神無月', '秋高气爽 红叶满山'],
  11: ['霜月', '寒意渐浓 红叶飘零'],
  12: ['師走', '岁末将至 一年将尽'],
};

export function diaryRepoPath(year, month) {
  return `content/niki/niki_${year}${pad2(month)}.md`;
}

/** 新建整月时的正文骨架（front matter 之外的部分，契约 §3.2） */
export function diaryBodyTemplate(year, month) {
  const m = Number(month);
  const mm = pad2(m);
  const [kana, phrase] = MONTH_INFO[m] || ['', ''];
  const L = [];
  L.push('<center>');
  L.push(`${year}年 ${m}月`);
  L.push('</center>');
  L.push('{{< niki-cal >}}');
  L.push('<br>');
  L.push('<center>');
  L.push(`<b>${kana} ${phrase}</b>`);
  L.push('</center>');
  L.push('<br>');
  L.push('<hr />');
  L.push('');
  L.push(`<h2><span id="${mm}01">${m}月 1日</span></h2>`);
  L.push('');
  L.push('在这里写这一天的事。');
  L.push('');
  L.push('<!--more-->');
  L.push('');
  return L.join('\n');
}

/** 整月文件的完整内容（含 front matter） */
export function diaryFileTemplate(year, month, draft = false) {
  const m = Number(month);
  return (
    '---\n' +
    `title: "${year}年${m}月日记"\n` +
    `date: ${year}-${pad2(m)}-01\n` +
    `draft: ${draft ? 'true' : 'false'}\n` +
    'description: ""\n' +
    '---\n\n' +
    diaryBodyTemplate(year, m)
  );
}

const DAY_HEADING_RE = /<h([1-6])\b[^>]*>/gi;
const DAY_SPAN_RE = /<span\s+id=["'](\d{2})(\d{2})["'][^>]*>/i;

/**
 * 找出所有「日期小节」。
 * 返回 [{id, start, headingEnd, end}]：
 *   start      标题标签起点
 *   headingEnd 标题闭合标签之后
 *   end        小节结束（下一个日标题 / 下一个 <h2 / <!--more--> / 文件末尾）
 * 兼容老日记用 <h1> 的情况；新写入统一用 <h2>。
 */
export function findDiarySections(text) {
  const s = String(text || '');
  const headings = [];
  DAY_HEADING_RE.lastIndex = 0;
  let m;
  while ((m = DAY_HEADING_RE.exec(s))) {
    const level = Number(m[1]);
    const openStart = m.index;
    const openEnd = DAY_HEADING_RE.lastIndex;
    const closeTag = `</h${level}>`;
    const closeIdx = s.toLowerCase().indexOf(closeTag, openEnd);
    if (closeIdx < 0) continue;
    const headingEnd = closeIdx + closeTag.length;
    const inner = s.slice(openEnd, closeIdx);
    const span = inner.match(DAY_SPAN_RE);
    headings.push({
      level,
      start: openStart,
      headingEnd,
      id: span ? span[1] + span[2] : null,
    });
  }

  const sections = [];
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    if (!h.id) continue;
    let end = s.length;
    // 下一个日标题（任意级别）
    const nextDay = headings.slice(i + 1).find((x) => x.id);
    if (nextDay) end = Math.min(end, nextDay.start);
    // 契约：下一个 <h2（即便没有日期锚点）也算小节结束
    const nextH2 = s.slice(h.headingEnd).search(/<h2\b/i);
    if (nextH2 >= 0) end = Math.min(end, h.headingEnd + nextH2);
    // <!--more--> 之后的内容不属于任何一天
    const more = s.indexOf('<!--more-->', h.headingEnd);
    if (more >= 0) end = Math.min(end, more);
    if (end < h.headingEnd) end = h.headingEnd;
    sections.push({ id: h.id, start: h.start, headingEnd: h.headingEnd, end });
  }
  return sections;
}

/** 从整篇日记里抽已写日期：[{day, id, date}]，按日期升序 */
export function extractDiaryDays(text, year, month) {
  const s = String(text || '');
  const seen = new Set();
  const days = [];
  const re = /<span\s+id=["'](\d{2})(\d{2})["']/g;
  let m;
  while ((m = re.exec(s))) {
    const id = m[1] + m[2];
    if (seen.has(id)) continue;
    seen.add(id);
    const mm = m[1];
    const dd = m[2];
    days.push({
      day: Number(dd),
      id,
      date: `${year}-${mm}-${dd}`,
    });
  }
  days.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return days;
}

/**
 * 写某一天（契约 §3.3）。
 * - 已有该天小节：替换正文，保留标题行
 * - 没有：按 id 排序插到第一个更大的日标题前；没有更大的就插到 <!--more--> 前；
 *   没有 <!--more--> 就追加到文件末尾
 * @returns {string} 写入后的完整文本
 */
export function applyDiaryDay(text, year, month, day, html) {
  const s = String(text || '');
  const m = Number(month);
  const d = Number(day);
  const mm = pad2(m);
  const dd = pad2(d);
  const id = mm + dd;
  const body = String(html == null ? '' : html).trim();
  const heading = `<h2><span id="${id}">${m}月 ${d}日</span></h2>`;

  const sections = findDiarySections(s);
  const hit = sections.find((x) => x.id === id);
  if (hit) {
    const headingText = s.slice(hit.start, hit.headingEnd).trimEnd();
    const next = `${headingText}\n\n${body}\n\n`;
    return s.slice(0, hit.start) + next + s.slice(hit.end);
  }

  const greater = sections.find((x) => x.id > id);
  let pos;
  if (greater) {
    pos = greater.start;
  } else {
    const more = s.indexOf('<!--more-->');
    pos = more >= 0 ? more : s.length;
  }

  const block = `${heading}\n\n${body}\n\n`;
  if (pos >= s.length) {
    const before = s.replace(/[ \t\r\n]+$/, '');
    return (before ? before + '\n\n' : '') + block;
  }
  const before = s.slice(0, pos).replace(/[ \t\r\n]+$/, '');
  return (before ? before + '\n\n' : '') + block + s.slice(pos);
}

/* ============================================================
   8. 布告栏转发（契约 §4）
   ============================================================ */

/**
 * 带 x-board-token 转发到 env.BOARD_API；token 只在上游请求头里，不进响应。
 * 返回布告栏后端的 JSON（状态码原样透传）；连不上 502。
 */
export async function boardAdminFetch(env, path, init = {}) {
  const base = String((env && env.BOARD_API) || '').replace(/\/+$/, '');
  const token = String((env && env.BOARD_ADMIN_TOKEN) || '');
  if (!base || !token) throw new HttpError(500, '服务端还没配置 BOARD_API / BOARD_ADMIN_TOKEN');

  let res;
  try {
    res = await fetch(base + path, {
      method: init.method || 'GET',
      body: init.body,
      headers: {
        'x-board-token': token,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
  } catch (e) {
    throw new HttpError(502, '布告栏后端连不上');
  }

  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (e) {
    throw new HttpError(502, '布告栏后端连不上');
  }
  return { status: res.status, data };
}

/* ============================================================
   9. 并发控制
   ============================================================ */

/** 最多 limit 个并发，结果顺序和输入一致 */
export async function mapLimit(items, limit, fn) {
  const list = Array.from(items || []);
  const out = new Array(list.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), list.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= list.length) return;
      out[i] = await fn(list[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}
