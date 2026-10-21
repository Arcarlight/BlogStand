/* ==========================================================================
   app.js —— 星虹巢·写作间（mobile-editor 前端）
   --------------------------------------------------------------------------
   纯 ES module：无框架、无 CDN、无构建。hash 路由 + 全部视图 + API 调用。
   契约：../CONTRACT.md（§5 前端、§4 接口、§3.5 图片）。
   ========================================================================== */

/* ==========================================================================
   0. 小工具
   ========================================================================== */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));

const pad2 = (n) => String(n).padStart(2, '0');

/** 北京时间（UTC+8）的今天，'YYYY-MM-DD' */
function todayCN() {
  const now = new Date();
  const bj = new Date(now.getTime() + (now.getTimezoneOffset() + 480) * 60000);
  return `${bj.getFullYear()}-${pad2(bj.getMonth() + 1)}-${pad2(bj.getDate())}`;
}

function partsOfDate(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
  if (!m) return null;
  return { year: +m[1], month: +m[2], day: +m[3] };
}

function dateOfParts(year, month, day) {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/** '2026-10-21T19:20:00+08:00' -> '10-21 19:20'（解析不了就原样返回） */
function fmtDT(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(String(iso || ''));
  if (!m) return String(iso || '');
  return `${m[2]}-${m[3]} ${m[4]}:${m[5]}`;
}

/** 相对时间，给「恢复草稿」提示用 */
function fmtAgo(ts) {
  if (!ts) return '刚才';
  const min = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (min < 1) return '刚才';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.round(h / 24)} 天前`;
}

const shortPath = (p) =>
  String(p || '').replace(/^content\//, '').replace(/\.md$/i, '');

/* ==========================================================================
   1. 图标（内联 SVG，离线可用，不引任何 CDN）
   ========================================================================== */

const ICONS = {
  'chevron-left': '<path d="M15 5l-7 7 7 7"/>',
  'chevron-right': '<path d="M9 5l7 7-7 7"/>',
  pen: '<path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17v3z"/><path d="M14 7l3 3"/>',
  book: '<path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H11v16H5.5A1.5 1.5 0 0 1 4 18.5z"/><path d="M13 4h5.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H13z"/>',
  file: '<path d="M13 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9z"/><path d="M13 3v6h6"/>',
  board: '<path d="M20 12a7 7 0 0 1-7 7H8l-4 2v-9a7 7 0 0 1 7-7h2a7 7 0 0 1 7 7z"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="8.8" cy="9.6" r="1.5"/><path d="M4 17l5-5 4 4 3-2.6 4 3.6"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 4v5h-5"/>',
  logout: '<path d="M14 12H4"/><path d="M8 8l-4 4 4 4"/><path d="M11 4h7a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-7"/>',
  reply: '<path d="M9 5L4 10l5 5"/><path d="M4 10h9a7 7 0 0 1 7 7v2"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
  'eye-off': '<path d="M3 3l18 18"/><path d="M10.6 6.2A9.6 9.6 0 0 1 12 6c6 0 9.5 6 9.5 6a16 16 0 0 1-2.5 3.2"/><path d="M6.4 7.6C4 9.2 2.5 12 2.5 12S6 18 12 18a9.9 9.9 0 0 0 4.2-.9"/>',
  trash: '<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/><path d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7"/>',
  spark: '<path d="M12 3l2.1 5.4L20 11l-5.9 2.6L12 19l-2.1-5.4L4 11l5.9-2.6z"/>',
  check: '<path d="M20 6L9 17l-5-5"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 8v4.4l3 1.8"/>',
};

function icon(name) {
  return `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
    focusable="false">${ICONS[name] || ''}</svg>`;
}

/* ==========================================================================
   2. API 客户端
   --------------------------------------------------------------------------
   所有请求 credentials:'include'；写请求自动带 x-editor: 1（CSRF 护栏）。
   401：清会话、跳 #/login（登录接口自己的 401 不在此列，用 keep401）。
   ========================================================================== */

class ApiError extends Error {
  constructor(status, message, data) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data || null;
  }
}

let sessionCache = null;
let hadSession = false; // 这次打开页面之后，有没有成功登录过（决定要不要提示「登录过期」）

async function api(path, { method = 'GET', json, keep401 = false } = {}) {
  const headers = { Accept: 'application/json' };
  const init = { method, headers, credentials: 'include', cache: 'no-store' };
  if (method !== 'GET' && method !== 'HEAD') headers['x-editor'] = '1';
  if (json !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(json);
  }

  let res;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError(0, '网络连不上，检查一下网络再试');
  }

  let data = null;
  if ((res.headers.get('content-type') || '').includes('json')) {
    try { data = await res.json(); } catch { data = null; }
  }

  if (res.status === 401 && !keep401) {
    sessionCache = null;
    handleUnauthorized();
    throw new ApiError(401, (data && data.error) || '需要登录', data);
  }
  if (!res.ok) {
    const msg = (data && (data.error || data.message)) || `请求失败（HTTP ${res.status}）`;
    throw new ApiError(res.status, msg, data);
  }
  return data == null ? {} : data;
}

function handleUnauthorized() {
  if (parseRoute().name === 'login') return;
  // 从没登录过就直接进登录页，别说「过期了」——第一次来的人会莫名其妙
  if (hadSession) toast('登录过期了，重新输一次口令', 'warn', 3600);
  location.hash = '#/login';
}

async function loadSession() {
  if (sessionCache) return sessionCache;
  sessionCache = await api('/api/session');
  hadSession = true;
  return sessionCache;
}

/* ==========================================================================
   3. Toast / Modal / Confirm
   ========================================================================== */

let toastTimer = 0;

function toast(msg, kind = 'info', ms = 2600) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.dataset.kind = kind;
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add('is-on'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('is-on');
    setTimeout(() => { el.hidden = true; }, 200);
  }, ms);
}

/**
 * 弹一个对话框，返回 {action, data} 或 null（取消/ESC）。
 * actions: [{label, value, kind:'primary'|'ghost'|'danger'}]
 * mount(dlg): 打开后挂事件；read(dlg): 关闭时取表单值。
 */
function modal({ title = '', bodyHTML = '', actions = [], mount = null, read = null }) {
  const dlg = document.getElementById('modal');
  return new Promise((resolve) => {
    if (dlg.open) {
      dlg.returnValue = '';
      dlg.close();
    }
    dlg.innerHTML =
      '<form method="dialog" class="modal-card">' +
      (title ? `<h2 class="modal-title">${esc(title)}</h2>` : '') +
      `<div class="modal-body">${bodyHTML}</div>` +
      '<div class="modal-actions">' +
      actions
        .map((a, i) =>
          `<button type="submit" class="btn btn--${a.kind || 'ghost'}" value="${esc(a.value != null ? a.value : String(i))}">${esc(a.label)}</button>`)
        .join('') +
      '</div></form>';

    const onClose = () => {
      dlg.removeEventListener('close', onClose);
      const action = dlg.returnValue || '';
      if (!action) { resolve(null); return; }
      let data = null;
      if (read) { try { data = read(dlg); } catch { data = null; } }
      resolve({ action, data });
    };
    dlg.addEventListener('close', onClose);
    dlg.returnValue = '';
    dlg.showModal();
    const first = dlg.querySelector('.btn--danger, .btn--primary') || dlg.querySelector('.btn');
    if (first) first.focus();
    if (mount) mount(dlg);
  });
}

async function confirmAction({ title, message, okLabel = '确定', cancelLabel = '取消', danger = false }) {
  const r = await modal({
    title,
    bodyHTML: `<p class="modal-text">${esc(message)}</p>`,
    actions: [
      { label: cancelLabel, value: 'cancel', kind: 'ghost' },
      { label: okLabel, value: 'ok', kind: danger ? 'danger' : 'primary' },
    ],
  });
  return !!r && r.action === 'ok';
}

/* ==========================================================================
   4. 会话失效 / 未保存提醒 / 视图生命周期
   ========================================================================== */

let seqCounter = 0;
let cleanups = [];
let unsaved = false;

function onCleanup(fn) { cleanups.push(fn); }

function runCleanups() {
  const list = cleanups;
  cleanups = [];
  for (const fn of list) { try { fn(); } catch { /* 清理失败不影响下一页 */ } }
}

function setUnsaved(v) { unsaved = !!v; }

window.addEventListener('beforeunload', (e) => {
  if (!unsaved) return;
  e.preventDefault();
  e.returnValue = '';
  return '';
});

function setBtnBusy(btn, isBusy, busyText = '处理中…') {
  if (!btn) return;
  if (isBusy) {
    if (btn.dataset.idleLabel == null) btn.dataset.idleLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = busyText;
    btn.setAttribute('aria-busy', 'true');
  } else {
    btn.disabled = false;
    if (btn.dataset.idleLabel != null) {
      btn.textContent = btn.dataset.idleLabel;
      delete btn.dataset.idleLabel;
    }
    btn.removeAttribute('aria-busy');
  }
}

/* ==========================================================================
   5. 构建状态条
   --------------------------------------------------------------------------
   /api/build 只在「发布/保存之后」轮询：每 15 秒一次，conclusion 出来就停，
   最多跑 20 分钟（80 次），防止一直挂着。
   ========================================================================== */

let buildPoll = null;
let pollBuildAfterSave = false;

function stopBuildPoll() {
  if (buildPoll) {
    clearInterval(buildPoll.timer);
    buildPoll = null;
  }
}

function startBuildPoll(onUpdate) {
  stopBuildPoll();
  let runs = 0;

  const tick = async () => {
    runs += 1;
    let data = null;
    try {
      data = await api('/api/build');
    } catch (err) {
      if (err && err.status === 401) { stopBuildPoll(); return; }
      // 网络抖动就等下一轮，别把轮询停掉
    }
    if (data) onUpdate(data);
    const done = !!(data && (data.status === 'completed' || data.conclusion));
    if (done || runs >= 80) stopBuildPoll();
  };

  tick();
  buildPoll = { timer: setInterval(tick, 15000) };
}

const BUILD_STATUS = {
  queued: '排队中',
  waiting: '等待构建',
  pending: '准备中',
  requested: '已请求',
  in_progress: '构建中',
  completed: '构建结束',
};
const BUILD_CONCLUSION = {
  success: '构建成功',
  failure: '构建失败',
  cancelled: '构建被取消',
  skipped: '构建被跳过',
  timed_out: '构建超时',
  startup_failure: '构建启动失败',
  action_required: '构建需要人工处理',
};

function renderBuildBar(el, data) {
  if (!el) return;
  if (!data || data.status == null) {
    el.dataset.state = 'idle';
    el.innerHTML =
      '<span class="builddot" aria-hidden="true"></span>' +
      '<div class="buildmain"><strong>还没有构建记录</strong>' +
      '<span class="buildsub">发布之后，这里会显示站点构建的进度</span></div>';
    return;
  }

  let state = 'running';
  let title = BUILD_STATUS[data.status] || '构建状态未知';
  if (data.conclusion) {
    title = BUILD_CONCLUSION[data.conclusion] || `构建结束（${data.conclusion}）`;
    state = data.conclusion === 'success' ? 'ok' : 'bad';
  } else if (data.status === 'completed') {
    state = 'idle';
  }

  const sub = [];
  if (data.runNumber) sub.push('#' + data.runNumber);
  if (data.createdAt) sub.push(fmtDT(data.createdAt));
  if (data.headSha) sub.push(String(data.headSha).slice(0, 7));

  el.dataset.state = state;
  el.innerHTML =
    '<span class="builddot" aria-hidden="true"></span>' +
    `<div class="buildmain"><strong>${esc(title)}</strong>` +
    `<span class="buildsub">${esc(sub.join(' · '))}</span></div>` +
    (data.htmlUrl
      ? `<a class="buildlink" href="${esc(data.htmlUrl)}" target="_blank" rel="noopener noreferrer">日志</a>`
      : '');
}

/* ==========================================================================
   6. 本地草稿（每 2 秒存一次）
   ========================================================================== */

const DRAFT_PREFIX = 'be:draft:';

function draftStore(key) {
  const lsKey = DRAFT_PREFIX + key;
  return {
    get() {
      try {
        const raw = localStorage.getItem(lsKey);
        return raw ? JSON.parse(raw) : null;
      } catch { return null; }
    },
    put(value) {
      try { localStorage.setItem(lsKey, JSON.stringify({ ...value, at: Date.now() })); } catch { /* 满了就算了 */ }
    },
    del() {
      try { localStorage.removeItem(lsKey); } catch { /* 无所谓 */ }
    },
  };
}

/**
 * 每 2 秒看一眼 get()：内容变了才写；get() 返回 null 表示没有草稿了（删掉）。
 * 返回 stop 函数。
 */
function startAutosave(get, store, every = 2000) {
  let last;
  try { last = JSON.stringify(get()); } catch { last = null; }
  const timer = setInterval(() => {
    let value;
    try { value = get(); } catch { return; }
    const json = value == null ? null : JSON.stringify(value);
    if (json === last) return;
    last = json;
    if (value == null) store.del();
    else store.put(value);
  }, every);
  return () => clearInterval(timer);
}

/* ==========================================================================
   7. 图片：浏览器里压好再上传（CONTRACT §3.5）
   --------------------------------------------------------------------------
   长边 > 1600 先缩到 1600；带透明的 PNG 保持 PNG，其它 jpeg q0.85；
   另外出一张 webp 兄弟（q0.82），浏览器压不了 webp 就传 null。
   ========================================================================== */

const MAX_EDGE = 1600;
const JPEG_QUALITY = 0.85;
const WEBP_QUALITY = 0.82;
const MAX_UPLOAD_JSON = 11.5 * 1024 * 1024; // 后端 JSON 上限 12MB

function loadImageEl(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ el: img, w: img.naturalWidth || 1, h: img.naturalHeight || 1 });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('图片打不开，换一张试试'));
    };
    img.src = url;
  });
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob || null), type, quality);
    } catch {
      resolve(null);
    }
  });
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const s = String(reader.result || '');
      const i = s.indexOf(',');
      resolve(i === -1 ? '' : s.slice(i + 1));
    };
    reader.onerror = () => reject(new Error('读取图片数据失败'));
    reader.readAsDataURL(blob);
  });
}

function canvasHasAlpha(ctx, w, h) {
  try {
    const data = ctx.getImageData(0, 0, w, h).data;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] !== 255) return true;
    }
    return false;
  } catch {
    return true; // 读不到像素就保守地当成有透明
  }
}

function safeUploadName(originalName, mime) {
  const ext = mime === 'image/png' ? '.png' : '.jpg';
  let stem = String(originalName || 'image')
    .replace(/\.[^.]+$/, '')
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  if (!stem) stem = 'image';
  if (stem.length > 60) stem = stem.slice(0, 60);
  return stem + ext;
}

/** 把一张 File 压成 {name, original:{mime,b64}, webp:{b64}|null} */
async function compressForUpload(file) {
  if (!file || !String(file.type || '').startsWith('image/')) {
    throw new Error('只支持图片文件');
  }
  if (file.type === 'image/svg+xml') {
    throw new Error('svg 不压缩也不上传，先转成 png/jpg');
  }
  if (file.size > 30 * 1024 * 1024) {
    throw new Error('这张图超过 30MB，先把体积弄小一点');
  }

  const image = await loadImageEl(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(image.w, image.h));
  const w = Math.max(1, Math.round(image.w * scale));
  const h = Math.max(1, Math.round(image.h * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) throw new Error('这个浏览器没有 Canvas，压不了图');
  ctx.drawImage(image.el, 0, 0, w, h);

  // 带透明的 PNG 保持 PNG；照片/其它一律转 jpeg
  const keepPng = file.type === 'image/png' && canvasHasAlpha(ctx, w, h);
  const mime = keepPng ? 'image/png' : 'image/jpeg';
  const mainBlob = await canvasToBlob(canvas, mime, keepPng ? undefined : JPEG_QUALITY);
  if (!mainBlob) throw new Error('浏览器压不出这张图，换个格式试试');

  // webp 兄弟。浏览器不支持 webp 编码时 toBlob 会回落成 png，那就传 null。
  const webpBlob = await canvasToBlob(canvas, 'image/webp', WEBP_QUALITY);
  const webpOk = !!webpBlob && webpBlob.type === 'image/webp';

  const original = { mime: mainBlob.type || mime, b64: await blobToBase64(mainBlob) };
  const webp = webpOk ? { b64: await blobToBase64(webpBlob) } : null;

  const total = original.b64.length + (webp ? webp.b64.length : 0);
  if (total > MAX_UPLOAD_JSON) {
    throw new Error(`压完还有 ${(total / 1024 / 1024).toFixed(1)}MB（base64），太大了`);
  }

  return {
    name: safeUploadName(file.name, original.mime),
    original,
    webp,
  };
}

function pictureSnippet({ url, webp }, altText) {
  const source = webp && webp.url
    ? `<source type="image/webp" srcset="${esc(webp.url)}">`
    : '';
  const alt = esc(altText || '插图');
  return `<center><picture>${source}<img src="${esc(url)}" alt="${alt}" width="350" loading="lazy" /></picture></center>`;
}

function insertAtCursor(textarea, text) {
  const value = textarea.value;
  const start = textarea.selectionStart == null ? value.length : textarea.selectionStart;
  const end = textarea.selectionEnd == null ? start : textarea.selectionEnd;
  const before = value.slice(0, start);
  const after = value.slice(end);

  let pre = '';
  if (before !== '') pre = before.endsWith('\n\n') ? '' : (before.endsWith('\n') ? '\n' : '\n\n');
  let post = '';
  if (after !== '') post = after.startsWith('\n') ? '\n' : '\n\n';

  textarea.value = before + pre + text + post + after;
  const caret = (before + pre + text).length;
  textarea.focus();
  textarea.setSelectionRange(caret, caret);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * 选中的图片逐张压缩、上传、插到光标处。
 * 返回插入成功的张数。
 */
async function insertImages(files, textarea) {
  let done = 0;
  for (const file of files) {
    try {
      toast(`正在处理 ${file.name}…`, 'info', 1400);
      const payload = await compressForUpload(file);
      const result = await api('/api/upload', { method: 'POST', json: payload });
      const snippet = pictureSnippet(result, file.name.replace(/\.[^.]+$/, ''));
      insertAtCursor(textarea, snippet);
      done += 1;
    } catch (err) {
      if (err && err.status === 401) return done;
      toast(`「${file.name}」没传上去：${err.message || '出错了'}`, 'err', 4200);
    }
  }
  if (done > 0) toast(`插入了 ${done} 张图片`, 'ok');
  return done;
}

/* ==========================================================================
   8. 路由
   ========================================================================== */

const ROUTE_NAMES = ['home', 'login', 'blogNew', 'diary', 'posts', 'post', 'board'];

function parseRoute() {
  const raw = String(location.hash || '').replace(/^#/, '');
  const path = raw.startsWith('/') ? raw : '/' + raw;
  const parts = path.split('/').filter(Boolean);
  const head = parts[0] || '';

  if (!head) return { name: 'home' };
  if (head === 'login') return { name: 'login' };
  if (head === 'blog' && parts[1] === 'new') return { name: 'blogNew' };
  if (head === 'diary') return { name: 'diary' };
  if (head === 'posts') return { name: 'posts' };
  if (head === 'board') return { name: 'board' };
  if (head === 'post') {
    const encoded = parts.slice(1).join('/');
    let filePath = encoded;
    try { filePath = decodeURIComponent(encoded); } catch { /* 就用原文 */ }
    return filePath ? { name: 'post', path: filePath } : { name: 'posts' };
  }
  return { name: 'home' };
}

const postHash = (path) => '#/post/' + encodeURIComponent(path);

function bootingHTML(message = '正在连接写作间…') {
  return `<div class="booting"><div class="spinner" aria-hidden="true"></div><p>${esc(message)}</p></div>`;
}

function emptyHTML(text) {
  return `<div class="emptybox"><p>${esc(text)}</p></div>`;
}

function renderError(err, title = '打不开这个页面') {
  const root = appEl();
  const message = (err && err.message) || '未知错误';
  root.innerHTML = `
    <div class="view">
      <header class="vbar">
        <a class="iconbtn" href="#/" aria-label="回首页">${icon('chevron-left')}</a>
        <h1 class="vtitle">${esc(title)}</h1>
        <span class="vbar-spacer"></span>
      </header>
      <div class="vbody">
        <div class="emptybox">
          <h2>${esc(title)}</h2>
          <p>${esc(message)}</p>
          <div class="emptybox-actions">
            <a class="btn btn--ghost" href="#/">回首页</a>
            <button class="btn btn--primary" type="button" id="retry">再试一次</button>
          </div>
        </div>
      </div>
    </div>`;
  const retry = document.getElementById('retry');
  if (retry) retry.addEventListener('click', () => { render().catch((e) => renderError(e)); });
}

function appEl() { return document.getElementById('app'); }

async function render() {
  const seq = ++seqCounter;
  runCleanups();
  stopBuildPoll();
  setUnsaved(false);

  const route = parseRoute();
  document.body.dataset.view = route.name;
  window.scrollTo(0, 0);

  if (route.name === 'login') {
    views.login(route, seq);
    return;
  }

  const root = appEl();
  root.innerHTML = bootingHTML();

  try {
    const session = await loadSession();
    if (seq !== seqCounter) return;
    const view = views[route.name] || views.home;
    await view(route, seq, session);
  } catch (err) {
    if (seq !== seqCounter) return;
    if (err && err.status === 401) return; // api() 已经把我们送去登录页了
    renderError(err);
  }
}

/* ==========================================================================
   9. 视图：登录
   ========================================================================== */

const views = {};

views.login = async (route, seq) => {
  document.title = '登录 · 写作间';
  const root = appEl();
  root.innerHTML = `
    <div class="login">
      <div class="login-mark">${icon('spark')}</div>
      <h1>星虹巢<span>·写作间</span></h1>
      <p class="login-sub">输入口令，进到写东西的地方。这台设备会记住 30 天。</p>
      <form class="login-form" id="login-form" novalidate>
        <label class="field field--flush">
          <span class="field-label">口令</span>
          <input class="input" id="pass" type="password" name="pass"
            autocomplete="current-password" autocapitalize="off" autocorrect="off"
            spellcheck="false" enterkeyhint="go" required>
        </label>
        <p class="formerror" id="login-error" role="alert" hidden></p>
        <button class="btn btn--primary btn--block" id="login-btn" type="submit">进入写作间</button>
      </form>
    </div>`;

  const form = $('#login-form', root);
  const passEl = $('#pass', root);
  const btn = $('#login-btn', root);
  const errEl = $('#login-error', root);

  const showError = (msg) => {
    errEl.textContent = msg;
    errEl.hidden = !msg;
  };

  passEl.focus();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const pass = passEl.value;
    if (!pass) { showError('先输一口令再进。'); passEl.focus(); return; }
    showError('');
    setBtnBusy(btn, true, '验证中…');
    try {
      await api('/api/login', { method: 'POST', json: { pass }, keep401: true });
      sessionCache = null;
      hadSession = true;
      location.hash = '#/';
    } catch (err) {
      if (err.status === 429 || err.status === 500) showError(err.message);
      else if (err.status === 0) showError(err.message);
      else showError(err.message || '口令不对');
      passEl.select();
    } finally {
      setBtnBusy(btn, false);
    }
  });
};

/* ==========================================================================
   10. 视图：首页
   ========================================================================== */

views.home = async (route, seq) => {
  document.title = '写作间 · 星虹巢';
  const root = appEl();

  let build = null;
  try { build = await api('/api/build'); } catch (err) { if (err && err.status === 401) return; }
  if (seq !== seqCounter) return;

  const session = sessionCache || {};
  const where = [session.repo, session.branch].filter(Boolean).join(' · ');

  root.innerHTML = `
    <div class="home">
      <header class="homehead">
        <div class="brand">
          <h1>星虹巢</h1>
          <p class="brand-sub">写作间</p>
        </div>
        <button class="iconbtn" id="logout" type="button" aria-label="退出登录" title="退出登录">${icon('logout')}</button>
      </header>
      <div class="homebody">
        <section class="buildbar" id="buildbar" data-state="idle" aria-label="构建状态"></section>
        <nav class="cards" aria-label="去哪里写">
          <a class="card" href="#/blog/new">
            ${icon('pen')}
            <span class="card-title">写博客</span>
            <span class="card-desc">新的一篇，带图片</span>
          </a>
          <a class="card" href="#/diary">
            ${icon('book')}
            <span class="card-title">写日记</span>
            <span class="card-desc">补今天，或者补以前</span>
          </a>
          <a class="card" href="#/posts">
            ${icon('file')}
            <span class="card-title">改文章</span>
            <span class="card-desc">搜标题，改原文</span>
          </a>
          <a class="card" href="#/board">
            ${icon('board')}
            <span class="card-title">留言板</span>
            <span class="card-desc">答复、隐藏、删掉</span>
          </a>
        </nav>
      </div>
      <footer class="homefoot">
        已登录${where ? ' · <span class="mono">' + esc(where) + '</span>' : ''}<br>
        写的东西会提交到仓库，然后等站点构建。
      </footer>
    </div>`;

  renderBuildBar($('#buildbar', root), build);

  const logoutBtn = $('#logout', root);
  logoutBtn.addEventListener('click', async () => {
    try { await api('/api/logout', { method: 'POST', json: {} }); } catch { /* 退不干净也照样回登录页 */ }
    sessionCache = null;
    hadSession = false;
    stopBuildPoll();
    setUnsaved(false);
    location.hash = '#/login';
  });

  // 发布/保存之后回到首页：开始轮询构建状态
  if (pollBuildAfterSave) {
    pollBuildAfterSave = false;
    onCleanup(stopBuildPoll);
    let notified = false;
    startBuildPoll((data) => {
      renderBuildBar(document.getElementById('buildbar'), data);
      if (!notified && data && data.conclusion) {
        notified = true;
        const ok = data.conclusion === 'success';
        toast(ok ? '构建成功，站点更新好了' : `构建结束：${BUILD_CONCLUSION[data.conclusion] || data.conclusion}`,
          ok ? 'ok' : 'warn', 4200);
      }
    });
  }
};

/* ==========================================================================
   11. 视图：写博客
   ========================================================================== */

function cleanFileName(raw) {
  return String(raw || '')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
}

function blogMarkdown({ title, date, draft, body }) {
  const fmTitle = String(title || '').replace(/\r?\n/g, ' ').replace(/"/g, '\\"');
  const bodyText = String(body || '').replace(/\r\n/g, '\n').trim();
  const tail = bodyText ? bodyText + '\n\n' : '';
  return `---\ntitle: "${fmTitle}"\ndate: ${date}\ndraft: ${draft}\ntags: []\ndescription: ""\n---\n\n${tail}<!--more-->\n`;
}

views.blogNew = async (route, seq) => {
  document.title = '写博客 · 写作间';
  const root = appEl();
  const today = todayCN();
  const defaults = {
    title: '',
    name: 'post-' + today.replace(/-/g, ''),
    date: today,
    draft: true,
    body: '',
  };

  const store = draftStore('blog-new');
  const saved = store.get();
  const restored = !!(saved && saved.at && (saved.title || saved.body || saved.name || saved.date));
  const init = restored ? { ...defaults, ...saved } : defaults;

  root.innerHTML = `
    <div class="view">
      <header class="vbar">
        <a class="iconbtn" href="#/" aria-label="回首页">${icon('chevron-left')}</a>
        <h1 class="vtitle">写博客</h1>
        <span class="vbar-spacer"></span>
      </header>
      <div class="vbody">
        ${restored ? `<div class="notice" id="restore-note">
          <span>恢复了一份 ${esc(fmtAgo(saved.at))} 的本地草稿</span>
          <button type="button" class="linkbtn" id="discard-draft">丢掉</button>
        </div>` : ''}

        <label class="field">
          <span class="field-label">标题</span>
          <input id="f-title" class="input" type="text" placeholder="今天写点什么" value="${esc(init.title)}"
            autocomplete="off" enterkeyhint="next">
        </label>

        <div class="field-row">
          <label class="field">
            <span class="field-label">文件名</span>
            <input id="f-name" class="input input--mono" type="text" value="${esc(init.name)}"
              autocomplete="off" autocapitalize="off" spellcheck="false">
            <span class="field-hint mono" id="f-path-hint"></span>
          </label>
          <label class="field">
            <span class="field-label">日期</span>
            <input id="f-date" class="input input--date" type="date" value="${esc(init.date)}">
          </label>
        </div>

        <label class="switch">
          <input id="f-draft" type="checkbox" ${init.draft ? 'checked' : ''}>
          <span class="switch-track" aria-hidden="true"></span>
          <span class="switch-text">存为草稿<span class="field-hint" id="draft-hint"></span></span>
        </label>

        <div class="field">
          <div class="field-head">
            <span class="field-label">正文</span>
            <div class="field-tools">
              <button type="button" class="toolbtn" id="btn-img">${icon('image')} 插入图片</button>
            </div>
          </div>
          <textarea id="f-body" class="input textarea textarea--tall"
            placeholder="正文，可以混写 Markdown 和 HTML…" spellcheck="false">${esc(init.body)}</textarea>
          <input id="f-file" type="file" accept="image/*" multiple hidden>
          <span class="field-hint" id="wordcount"></span>
        </div>
      </div>
      <footer class="actionbar">
        <button type="button" class="btn btn--primary btn--grow" id="btn-save">存为草稿</button>
      </footer>
    </div>`;

  const titleEl = $('#f-title', root);
  const nameEl = $('#f-name', root);
  const dateEl = $('#f-date', root);
  const draftEl = $('#f-draft', root);
  const bodyEl = $('#f-body', root);
  const fileEl = $('#f-file', root);
  const saveBtn = $('#btn-save', root);
  const pathHint = $('#f-path-hint', root);
  const wcEl = $('#wordcount', root);
  const draftHint = $('#draft-hint', root);
  const imgBtn = $('#btn-img', root);

  const collect = () => ({
    title: titleEl.value,
    name: cleanFileName(nameEl.value),
    date: dateEl.value,
    draft: draftEl.checked,
    body: bodyEl.value,
  });

  const hasWork = () => !!(titleEl.value.trim() || bodyEl.value.trim());

  const syncPath = () => {
    pathHint.textContent = 'content/blog/' + (cleanFileName(nameEl.value) || '…') + '.md';
  };
  syncPath();

  const syncWordCount = () => {
    const text = bodyEl.value;
    wcEl.textContent = `${text.length} 字 · ${text.split('\n').length} 行`;
  };
  syncWordCount();

  const updateSaveLabel = () => {
    saveBtn.textContent = draftEl.checked ? '存为草稿' : '发布并构建';
    draftHint.textContent = draftEl.checked
      ? 'draft: true，站点上看不到'
      : 'draft: false，推送后会触发构建';
  };
  updateSaveLabel();

  // 挂在本次视图的容器上（#app 是持久的，挂它上面换页后会泄漏）
  const viewEl = $('.view', root);
  viewEl.addEventListener('input', () => { setUnsaved(hasWork()); });
  viewEl.addEventListener('change', () => { setUnsaved(hasWork()); });

  // 输入时只去非法字符：**不能**每次都用 cleanFileName —— 它会把正在输入的
  // 结尾连字符/点吃掉（敲 "e2e-" 的下一个字符永远打不出来）。完整清洗留到保存时。
  nameEl.addEventListener('input', () => {
    nameEl.value = nameEl.value.replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, '-');
    syncPath();
  });
  bodyEl.addEventListener('input', syncWordCount);
  draftEl.addEventListener('change', updateSaveLabel);

  // 每 2 秒把还没发出去的内容存本地
  const stopAuto = startAutosave(() => (hasWork() ? collect() : null), store);
  onCleanup(stopAuto);
  onCleanup(() => setUnsaved(false));

  const discardBtn = $('#discard-draft', root);
  if (discardBtn) {
    discardBtn.addEventListener('click', async () => {
      const ok = await confirmAction({
        title: '丢掉本地草稿？',
        message: '只是清掉这台手机上暂存的内容，已经发布的东西不受影响。',
        okLabel: '丢掉',
        danger: true,
      });
      if (!ok) return;
      store.del();
      titleEl.value = defaults.title;
      nameEl.value = defaults.name;
      dateEl.value = defaults.date;
      draftEl.checked = defaults.draft;
      bodyEl.value = defaults.body;
      syncPath();
      syncWordCount();
      updateSaveLabel();
      setUnsaved(false);
      const note = $('#restore-note', root);
      if (note) note.remove();
      toast('草稿丢掉了', 'info');
    });
  }

  async function publish() {
    const title = titleEl.value.trim();
    const name = cleanFileName(nameEl.value);
    const date = dateEl.value || today;
    const asDraft = draftEl.checked;
    const body = bodyEl.value.replace(/\r\n/g, '\n');

    if (!title) { toast('先写个标题', 'warn'); titleEl.focus(); return; }
    if (!name) { toast('文件名不能空着', 'warn'); nameEl.focus(); return; }
    if (!date) { toast('选一个日期', 'warn'); dateEl.focus(); return; }

    const text = blogMarkdown({ title, date, draft: asDraft, body });

    setBtnBusy(saveBtn, true, asDraft ? '保存中…' : '发布中…');
    try {
      await api('/api/new', {
        method: 'POST',
        json: { kind: 'blog', name, title, date, draft: asDraft, text },
      });
      store.del();
      setUnsaved(false);
      pollBuildAfterSave = true;
      toast(asDraft ? '存成草稿了' : '发出去了，等构建', 'ok', 2600);
      location.hash = '#/';
    } catch (err) {
      if (err.status === 401) return;
      if (err.status === 409) {
        toast(err.message || '这个文件名已经有人用了，换一个', 'err', 4200);
        nameEl.focus();
        nameEl.select();
      } else {
        toast(err.message || '没能保存', 'err', 4200);
      }
    } finally {
      setBtnBusy(saveBtn, false);
      updateSaveLabel();
    }
  }

  saveBtn.addEventListener('click', publish);

  imgBtn.addEventListener('click', () => fileEl.click());
  fileEl.addEventListener('change', async () => {
    const files = Array.from(fileEl.files || []);
    fileEl.value = '';
    if (!files.length) return;
    imgBtn.disabled = true;
    try {
      await insertImages(files, bodyEl);
    } finally {
      imgBtn.disabled = false;
    }
  });

  setUnsaved(hasWork());
};

/* ==========================================================================
   12. 视图：写日记
   ========================================================================== */

/** 从整月 Markdown 里抠出某一天的正文（不含 <h2> 标题行） */
function extractDaySection(text, dayId) {
  const source = String(text || '');
  if (!source) return null;
  const re = new RegExp(`<h2[^>]*>\\s*<span[^>]*\\bid=["']${dayId}["'][^>]*>[\\s\\S]*?</span>\\s*</h2>`, 'i');
  const m = re.exec(source);
  if (!m) return null;
  const start = m.index + m[0].length;
  const rest = source.slice(start);
  const end = rest.search(/<h2[\s>/]|<!--\s*more\s*-->/i);
  const body = end === -1 ? rest : rest.slice(0, end);
  return body.replace(/^\s*\n/, '').replace(/\s+$/, '');
}

function scanDayIds(text) {
  const out = [];
  for (const m of String(text || '').matchAll(/<span\s+id=["'](\d{2})(\d{2})["']/g)) {
    out.push({ id: m[1] + m[2], day: +m[2] });
  }
  return out;
}

views.diary = async (route, seq) => {
  document.title = '写日记 · 写作间';
  const root = appEl();
  const today = todayCN();

  const state = {
    date: today,
    monthKey: '',
    month: null,
    original: '',
    stopAuto: null,
  };

  root.innerHTML = `
    <div class="view">
      <header class="vbar">
        <a class="iconbtn" href="#/" aria-label="回首页">${icon('chevron-left')}</a>
        <h1 class="vtitle">写日记</h1>
        <button class="iconbtn" id="btn-reload" type="button" aria-label="重新载入这一天" title="重新载入">${icon('refresh')}</button>
      </header>
      <div class="vbody">
        <div class="field">
          <span class="field-label">哪一天</span>
          <input id="f-date" class="input input--date" type="date" value="${esc(today)}">
        </div>

        <div class="field">
          <div class="field-head">
            <span class="field-label" id="month-label">本月已写</span>
            <span class="field-hint mono" id="month-path"></span>
          </div>
          <div class="chips" id="day-chips"></div>
        </div>

        <div id="diary-notice"></div>

        <div class="field">
          <div class="field-head">
            <span class="field-label">当天内容（HTML）</span>
            <div class="field-tools">
              <button type="button" class="toolbtn" id="btn-img">${icon('image')} 插入图片</button>
            </div>
          </div>
          <textarea id="f-body" class="input textarea textarea--tall"
            placeholder="换行写 &lt;br&gt;。这里只写当天这一节，标题由服务端负责。" spellcheck="false"></textarea>
          <input id="f-file" type="file" accept="image/*" multiple hidden>
          <span class="field-hint" id="body-hint"></span>
        </div>
      </div>
      <footer class="actionbar">
        <button type="button" class="btn btn--primary btn--grow" id="btn-save">保存这一天</button>
      </footer>
    </div>`;

  const dateEl = $('#f-date', root);
  const bodyEl = $('#f-body', root);
  const fileEl = $('#f-file', root);
  const saveBtn = $('#btn-save', root);
  const imgBtn = $('#btn-img', root);
  const chipsEl = $('#day-chips', root);
  const monthLabel = $('#month-label', root);
  const monthPath = $('#month-path', root);
  const bodyHint = $('#body-hint', root);
  const reloadBtn = $('#btn-reload', root);
  const noticeSlot = $('#diary-notice', root);

  const isDirty = () => bodyEl.value !== state.original;
  const markUnsaved = () => setUnsaved(isDirty());
  const clearNotice = () => { noticeSlot.innerHTML = ''; };

  async function fetchMonth(year, month) {
    try {
      const data = await api(`/api/diary?year=${year}&month=${month}`);
      return {
        path: data.path || `content/niki/niki_${year}${pad2(month)}.md`,
        exists: !!data.exists,
        text: data.text || '',
        days: Array.isArray(data.days) ? data.days : scanDayIds(data.text),
      };
    } catch (err) {
      if (err.status === 404) {
        return { path: `content/niki/niki_${year}${pad2(month)}.md`, exists: false, text: '', days: [] };
      }
      throw err;
    }
  }

  function renderChips() {
    const parts = partsOfDate(state.date);
    if (!parts || !state.month) { chipsEl.innerHTML = ''; return; }
    const days = (state.month.days || []).slice().sort((a, b) => a.day - b.day);
    monthLabel.textContent = `本月已写 · ${days.length} 天`;
    monthPath.textContent = state.month.path;
    if (!days.length) {
      chipsEl.innerHTML = '<span class="chips-empty">这个月还没有写过</span>';
      return;
    }
    chipsEl.innerHTML = days
      .map((d) => {
        const date = d.date || dateOfParts(parts.year, parts.month, d.day);
        const selected = date === state.date;
        return `<button type="button" class="chip" data-date="${esc(date)}" aria-pressed="${selected ? 'true' : 'false'}">${esc(d.day)}日</button>`;
      })
      .join('');
  }

  function updateBodyHint() {
    const parts = partsOfDate(state.date);
    if (!parts) { bodyHint.textContent = ''; return; }
    const missing = !state.month || !state.month.exists;
    bodyHint.textContent = missing
      ? '这个月还没有文件，保存时会按模板新建。'
      : '';
  }

  async function selectDay(dateStr, { confirmDiscard = true } = {}) {
    const parts = partsOfDate(dateStr);
    if (!parts) return false;

    if (confirmDiscard && isDirty()) {
      const ok = await confirmAction({
        title: '这一天的改动还没保存',
        message: '换到别的日子，现在写的内容会丢。',
        okLabel: '换过去',
        danger: true,
      });
      if (!ok) {
        dateEl.value = state.date;
        return false;
      }
    }

    const monthKey = `${parts.year}-${pad2(parts.month)}`;
    if (state.monthKey !== monthKey) {
      const month = await fetchMonth(parts.year, parts.month);
      if (seq !== seqCounter) return false;
      state.month = month;
      state.monthKey = monthKey;
    }

    state.date = dateStr;
    dateEl.value = dateStr;

    const dayId = pad2(parts.month) + pad2(parts.day);
    const section = extractDaySection(state.month.text, dayId);
    state.original = section == null ? '' : section;

    // 本地还有没保存的草稿？恢复它，并给个「丢掉」的出口
    const store = draftStore(`diary:${dateStr}`);
    const saved = store.get();
    let restored = false;
    if (saved && typeof saved.html === 'string' && saved.html !== state.original) {
      bodyEl.value = saved.html;
      restored = true;
    } else {
      bodyEl.value = state.original;
      if (saved) store.del();
    }

    const oldNotice = $('#restore-note', root);
    if (oldNotice) oldNotice.remove();
    noticeSlot.innerHTML = '';
    if (restored) {
      noticeSlot.innerHTML = `<div class="notice" id="restore-note">
        <span>恢复了 ${esc(fmtAgo(saved.at))} 的本地草稿</span>
        <button type="button" class="linkbtn" id="discard-draft">丢掉</button>
      </div>`;
      const discardBtn = $('#discard-draft', noticeSlot);
      discardBtn.addEventListener('click', () => {
        store.del();
        bodyEl.value = state.original;
        clearNotice();
        markUnsaved();
        toast('回到了线上的版本', 'info');
      });
    }

    renderChips();
    updateBodyHint();
    markUnsaved();

    // 换日期就换 autosave 的 key
    if (state.stopAuto) { state.stopAuto(); state.stopAuto = null; }
    state.stopAuto = startAutosave(
      () => (isDirty() ? { html: bodyEl.value } : null),
      store,
    );
    return true;
  }

  bodyEl.addEventListener('input', () => {
    markUnsaved();
    if ($('#restore-note', root)) clearNotice();
  });

  dateEl.addEventListener('change', async () => {
    const next = dateEl.value;
    if (!next) { dateEl.value = state.date; return; }
    if (next === state.date) return;
    await selectDay(next);
  });

  chipsEl.addEventListener('click', async (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    const next = chip.dataset.date;
    if (!next || next === state.date) return;
    await selectDay(next);
  });

  reloadBtn.addEventListener('click', async () => {
    if (isDirty()) {
      const ok = await confirmAction({
        title: '重新载入？',
        message: '线上这一天的内容会覆盖现在没保存的改动。',
        okLabel: '重新载入',
        danger: true,
      });
      if (!ok) return;
    }
    state.monthKey = '';
    state.original = '';
    const store = draftStore(`diary:${state.date}`);
    store.del();
    await selectDay(state.date, { confirmDiscard: false });
    toast('已重新载入', 'info', 1800);
  });

  saveBtn.addEventListener('click', async () => {
    const parts = partsOfDate(state.date);
    if (!parts) return;
    setBtnBusy(saveBtn, true, '保存中…');
    try {
      const res = await api('/api/diary', {
        method: 'POST',
        json: { year: parts.year, month: parts.month, day: parts.day, html: bodyEl.value.trim() },
      });
      if (seq !== seqCounter) return;
      if (state.month) {
        if (res && typeof res.text === 'string') {
          state.month.text = res.text;
          state.month.exists = true;
          state.month.days = scanDayIds(res.text);
        } else {
          state.month = await fetchMonth(parts.year, parts.month);
        }
        state.month.path = res.path || state.month.path;
      }
      state.original = bodyEl.value;
      draftStore(`diary:${state.date}`).del();
      clearNotice();
      renderChips();
      updateBodyHint();
      markUnsaved();
      pollBuildAfterSave = true;
      toast('保存好了', 'ok', 2200);
    } catch (err) {
      if (err.status === 401) return;
      toast(err.message || '没能保存', 'err', 4200);
    } finally {
      setBtnBusy(saveBtn, false, '保存这一天');
    }
  });

  imgBtn.addEventListener('click', () => fileEl.click());
  fileEl.addEventListener('change', async () => {
    const files = Array.from(fileEl.files || []);
    fileEl.value = '';
    if (!files.length) return;
    imgBtn.disabled = true;
    try {
      await insertImages(files, bodyEl);
    } finally {
      imgBtn.disabled = false;
    }
  });

  onCleanup(() => {
    setUnsaved(false);
    if (state.stopAuto) { state.stopAuto(); state.stopAuto = null; }
  });

  // 首屏：载入今天所在的月份和当天内容
  await selectDay(today, { confirmDiscard: false });
};

/* ==========================================================================
   13. 视图：改文章（列表 + 搜索）
   ========================================================================== */

const POST_KINDS = [
  { key: 'blog', label: '博客' },
  { key: 'page', label: '页面' },
  { key: 'collection', label: '文集' },
];

views.posts = async (route, seq) => {
  document.title = '改文章 · 写作间';
  const root = appEl();

  let kind = 'blog';
  let items = [];
  const cache = new Map();

  root.innerHTML = `
    <div class="view">
      <header class="vbar">
        <a class="iconbtn" href="#/" aria-label="回首页">${icon('chevron-left')}</a>
        <h1 class="vtitle">改文章</h1>
        <button class="iconbtn" id="btn-reload" type="button" aria-label="刷新列表" title="刷新列表">${icon('refresh')}</button>
      </header>
      <div class="vbody vbody--tight">
        <div class="searchrow">
          <input id="search" class="input" type="search" placeholder="搜标题或文件名…"
            autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="search">
        </div>
        <div class="tabs" id="tabs" role="tablist" aria-label="文章类型"></div>
        <div class="listmeta">
          <span id="list-count">…</span>
          <span>点开是原始 Markdown 全文</span>
        </div>
        <div id="post-list"></div>
      </div>
    </div>`;

  const listEl = $('#post-list', root);
  const searchEl = $('#search', root);
  const tabsEl = $('#tabs', root);
  const countEl = $('#list-count', root);
  const reloadBtn = $('#btn-reload', root);

  function renderTabs() {
    tabsEl.innerHTML = POST_KINDS.map((k) => {
      const cached = cache.get(k.key);
      const count = cached ? ` <span class="count">${cached.length}</span>` : '';
      return `<button type="button" class="tab" role="tab" data-kind="${k.key}"
        aria-selected="${k.key === kind ? 'true' : 'false'}">${esc(k.label)}${count}</button>`;
    }).join('');
  }

  function renderList() {
    const q = searchEl.value.trim().toLowerCase();
    const filtered = !q
      ? items
      : items.filter((it) =>
          `${it.title || ''} ${it.name || ''} ${it.path || ''}`.toLowerCase().includes(q));

    countEl.textContent = q
      ? `找到 ${filtered.length} / ${items.length} 篇`
      : `共 ${items.length} 篇`;

    if (!filtered.length) {
      listEl.innerHTML = emptyHTML(q ? '没找到匹配的文章' : '这一栏还是空的');
      return;
    }
    listEl.innerHTML = '<div class="list">' + filtered.map((it) => `
      <a class="listitem" href="${postHash(it.path)}">
        <span class="li-title">${esc(it.title || it.name || it.path)}</span>
        <span class="li-meta">
          ${it.date ? `<time datetime="${esc(it.date)}">${esc(it.date)}</time>` : ''}
          ${it.lastmod ? `<span>改于 ${esc(it.lastmod)}</span>` : ''}
          <span class="mono">${esc(shortPath(it.path))}</span>
          ${it.draft ? '<span class="tag tag--warn">草稿</span>' : ''}
        </span>
      </a>`).join('') + '</div>';
  }

  async function loadKind(nextKind, force = false) {
    kind = nextKind;
    renderTabs();
    if (!force && cache.has(kind)) {
      items = cache.get(kind);
      renderList();
      return;
    }
    listEl.innerHTML = bootingHTML('正在取列表…');
    countEl.textContent = '…';
    try {
      const data = await api('/api/list?kind=' + encodeURIComponent(kind));
      if (seq !== seqCounter) return;
      const list = (data.items || []).slice().sort((a, b) =>
        String(b.date || '').localeCompare(String(a.date || '')) ||
        String(a.name || '').localeCompare(String(b.name || '')));
      cache.set(kind, list);
      items = list;
      renderTabs();
      renderList();
    } catch (err) {
      if (err.status === 401) return;
      listEl.innerHTML = `<div class="emptybox"><p>${esc(err.message || '列表没取回来')}</p></div>`;
    }
  }

  tabsEl.addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (!tab || tab.dataset.kind === kind) return;
    loadKind(tab.dataset.kind);
  });

  searchEl.addEventListener('input', renderList);

  reloadBtn.addEventListener('click', () => {
    for (const k of POST_KINDS) cache.delete(k.key);
    loadKind(kind, true);
  });

  renderTabs();
  await loadKind(kind);
};

/* ==========================================================================
   14. 视图：编辑单篇文章（原始 Markdown）
   ========================================================================== */

views.post = async (route, seq) => {
  document.title = '编辑 · 写作间';
  const filePath = route.path;
  const root = appEl();

  let file;
  try {
    file = await api('/api/file?path=' + encodeURIComponent(filePath));
  } catch (err) {
    if (seq !== seqCounter) return;
    if (err.status === 401) return;
    if (err.status === 404) {
      root.innerHTML = `
        <div class="view">
          <header class="vbar">
            <a class="iconbtn" href="#/posts" aria-label="回文章列表">${icon('chevron-left')}</a>
            <h1 class="vtitle">文件不存在</h1>
            <span class="vbar-spacer"></span>
          </header>
          <div class="vbody">
            <div class="emptybox">
              <h2>没找到这个文件</h2>
              <p class="mono">${esc(filePath)}</p>
              <div class="emptybox-actions"><a class="btn btn--primary" href="#/posts">回文章列表</a></div>
            </div>
          </div>
        </div>`;
      return;
    }
    renderError(err, '读不了这篇文章');
    return;
  }
  if (seq !== seqCounter) return;

  const state = {
    sha: file.sha || null,
    original: String(file.text || ''),
  };
  const store = draftStore('post:' + filePath);
  const saved = store.get();
  let restored = false;
  let initialText = state.original;
  if (saved && typeof saved.text === 'string' && saved.text !== state.original) {
    initialText = saved.text;
    restored = true;
  }

  root.innerHTML = `
    <div class="view">
      <header class="vbar">
        <a class="iconbtn" href="#/posts" aria-label="回文章列表">${icon('chevron-left')}</a>
        <h1 class="vtitle">编辑</h1>
        <button class="iconbtn" id="btn-reload" type="button" aria-label="重新载入线上版本" title="重新载入">${icon('refresh')}</button>
      </header>
      <div class="vbody">
        <p class="pathline">${esc(filePath)}</p>
        ${restored ? `<div class="notice" id="restore-note">
          <span>恢复了 ${esc(fmtAgo(saved.at))} 的本地草稿（线上可能已经变了）</span>
          <button type="button" class="linkbtn" id="discard-draft">丢掉</button>
        </div>` : ''}
        <div class="field">
          <div class="field-head">
            <span class="field-label">原文（含 front matter）</span>
            <span class="field-hint">保存走 PUT /api/file</span>
          </div>
          <textarea id="f-body" class="input textarea textarea--code" spellcheck="false">${esc(initialText)}</textarea>
          <div class="charline">
            <span id="char-count"></span>
            <span class="savestate" id="save-state"></span>
          </div>
        </div>
      </div>
      <footer class="actionbar">
        <button type="button" class="btn btn--ghost" id="btn-reload2">重新载入</button>
        <button type="button" class="btn btn--primary btn--grow" id="btn-save">保存</button>
      </footer>
    </div>`;

  const bodyEl = $('#f-body', root);
  const saveBtn = $('#btn-save', root);
  const saveState = $('#save-state', root);
  const charCount = $('#char-count', root);
  const reloadBtn = $('#btn-reload', root);
  const reloadBtn2 = $('#btn-reload2', root);

  const isDirty = () => bodyEl.value !== state.original;

  const syncMeta = () => {
    const text = bodyEl.value;
    charCount.textContent = `${text.length} 字 · ${text.split('\n').length} 行`;
    setUnsaved(isDirty());
  };
  syncMeta();

  bodyEl.addEventListener('input', syncMeta);
  onCleanup(() => setUnsaved(false));

  const stopAuto = startAutosave(
    () => (isDirty() ? { text: bodyEl.value, sha: state.sha } : null),
    store,
  );
  onCleanup(stopAuto);

  const discardBtn = $('#discard-draft', root);
  if (discardBtn) {
    discardBtn.addEventListener('click', () => {
      store.del();
      bodyEl.value = state.original;
      syncMeta();
      const note = $('#restore-note', root);
      if (note) note.remove();
      toast('丢掉了本地草稿', 'info');
    });
  }

  async function handleConflict(conflict) {
    const onlineText = String((conflict && conflict.text) || '');
    const onlineSha = conflict && conflict.sha;
    // 服务端返回 sha:null 表示文件在线上被删了，这时「载入线上版本」没有意义
    const gone = !onlineSha;
    const r = await modal({
      title: gone ? '线上文件没了' : '线上版本变了',
      bodyHTML: gone
        ? `<p class="modal-text">这个文件在线上被删掉了（可能在别处删的）。</p>
           <p class="field-hint">你手里这份还能重新写回去。</p>`
        : `<p class="modal-text">这篇文章在你打开之后被别处改过。要用哪一份？</p>
           <p class="field-hint">线上 ${onlineText.length} 字 · 你这里 ${bodyEl.value.length} 字</p>`,
      actions: gone
        ? [
            { label: '取消', value: 'cancel', kind: 'ghost' },
            { label: '用我的覆盖（重建）', value: 'force', kind: 'danger' },
          ]
        : [
            { label: '取消', value: 'cancel', kind: 'ghost' },
            { label: '载入线上版本', value: 'load', kind: 'ghost' },
            { label: '用我的覆盖', value: 'force', kind: 'danger' },
          ],
    });
    if (!r) return;

    if (r.action === 'force') {
      await save(true, onlineSha || state.sha);
      return;
    }
    if (r.action === 'load' && !gone) {
      bodyEl.value = onlineText;
      state.sha = onlineSha;
      state.original = onlineText;
      store.del();
      syncMeta();
      const note = $('#restore-note', root);
      if (note) note.remove();
      saveState.textContent = '已载入线上版本';
      toast('载入了线上版本，本地改动已丢掉', 'info', 3200);
    }
  }

  async function save(force = false, shaOverride = null) {
    setBtnBusy(saveBtn, true, '保存中…');
    saveState.textContent = '';
    const payload = { path: filePath, text: bodyEl.value, sha: shaOverride || state.sha };
    if (force) payload.force = true;
    try {
      const res = await api('/api/file', { method: 'PUT', json: payload });
      if (seq !== seqCounter) return;
      if (res && res.sha) state.sha = res.sha;
      state.original = bodyEl.value;
      store.del();
      syncMeta();
      pollBuildAfterSave = true;
      const now = new Date();
      saveState.textContent = `已保存 ${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
      toast(force ? '已用你的版本覆盖' : '保存好了', 'ok', 2200);
    } catch (err) {
      if (err.status === 401) return;
      if (err.status === 409 && !force) {
        await handleConflict(err.data);
      } else {
        toast(err.message || '保存失败', 'err', 4200);
      }
    } finally {
      setBtnBusy(saveBtn, false, '保存');
    }
  }

  saveBtn.addEventListener('click', () => { save(false); });

  async function reloadFromServer() {
    if (isDirty()) {
      const ok = await confirmAction({
        title: '重新载入线上版本？',
        message: '现在没保存的改动会丢。',
        okLabel: '重新载入',
        danger: true,
      });
      if (!ok) return;
    }
    try {
      const fresh = await api('/api/file?path=' + encodeURIComponent(filePath));
      if (seq !== seqCounter) return;
      state.sha = fresh.sha || null;
      state.original = String(fresh.text || '');
      bodyEl.value = state.original;
      store.del();
      syncMeta();
      const note = $('#restore-note', root);
      if (note) note.remove();
      saveState.textContent = '已重新载入';
      toast('载入完成', 'info', 1800);
    } catch (err) {
      if (err.status === 401) return;
      toast(err.message || '重新载入失败', 'err', 4200);
    }
  }

  reloadBtn.addEventListener('click', reloadFromServer);
  reloadBtn2.addEventListener('click', reloadFromServer);
};

/* ==========================================================================
   15. 视图：留言板
   ========================================================================== */

const NOTE_COLORS = ['white', 'cream', 'yellow', 'pink', 'green', 'blue'];
const NOTE_FILTERS = [
  { key: 'visible', label: '显示中' },
  { key: 'hidden', label: '已隐藏' },
  { key: 'all', label: '全部' },
];

views.board = async (route, seq) => {
  document.title = '留言板 · 写作间';
  const root = appEl();

  let status = 'visible';
  let notes = [];
  let loaded = false;

  root.innerHTML = `
    <div class="view">
      <header class="vbar">
        <a class="iconbtn" href="#/" aria-label="回首页">${icon('chevron-left')}</a>
        <h1 class="vtitle">留言板</h1>
        <button class="iconbtn" id="btn-refresh" type="button" aria-label="刷新" title="刷新">${icon('refresh')}</button>
      </header>
      <div class="vbody vbody--tight">
        <div class="tabs" id="board-tabs" role="tablist" aria-label="便签状态"></div>
        <div class="listmeta">
          <span id="board-count">…</span>
          <span>答复落款固定是「虹星」</span>
        </div>
        <div id="board-list"></div>
      </div>
    </div>`;

  const listEl = $('#board-list', root);
  const tabsEl = $('#board-tabs', root);
  const countEl = $('#board-count', root);
  const refreshBtn = $('#btn-refresh', root);

  function renderTabs() {
    tabsEl.innerHTML = NOTE_FILTERS.map((f) => {
      const active = f.key === status;
      return `<button type="button" class="tab" role="tab" data-status="${f.key}"
        aria-selected="${active ? 'true' : 'false'}">${esc(f.label)}${active && loaded ? ` <span class="count">${notes.length}</span>` : ''}</button>`;
    }).join('');
  }

  function renderNotes() {
    countEl.textContent = loaded ? `共 ${notes.length} 张便签` : '…';
    if (!loaded) { listEl.innerHTML = bootingHTML('正在取留言…'); return; }
    if (!notes.length) {
      listEl.innerHTML = emptyHTML(status === 'hidden' ? '没有隐藏的便签' : '还没有人留言');
      return;
    }
    listEl.innerHTML = notes.map((n) => {
      const color = NOTE_COLORS.includes(n.color) ? n.color : 'white';
      const hidden = n.status === 'hidden';
      const reply = n.reply && typeof n.reply === 'object' ? n.reply : null;
      return `
        <article class="note note--${color}" data-id="${esc(n.id)}">
          <div class="note-head">
            <span class="note-id">#${esc(n.id)}</span>
            <span class="note-name">${esc(n.name || '匿名')}</span>
            <time class="note-time">${esc(fmtDT(n.at))}</time>
            ${hidden ? '<span class="tag tag--warn">已隐藏</span>' : ''}
          </div>
          <p class="note-body">${esc(n.body || '')}</p>
          ${reply
            ? `<div class="note-reply">
                 <span class="reply-by">${esc(reply.by || '虹星')} · ${esc(fmtDT(reply.at))}</span>
                 <p>${esc(reply.body || '')}</p>
               </div>`
            : '<p class="note-noreply">还没答复</p>'}
          <div class="note-actions">
            <button type="button" class="minibtn" data-act="reply">${icon('reply')} ${reply ? '改答复' : '答复'}</button>
            <button type="button" class="minibtn" data-act="hide">${icon(hidden ? 'eye' : 'eye-off')} ${hidden ? '恢复' : '隐藏'}</button>
            <button type="button" class="minibtn minibtn--danger" data-act="delete">${icon('trash')} 删掉</button>
          </div>
        </article>`;
    }).join('');
  }

  function patchNote(nextNote) {
    if (!nextNote) return;
    const id = nextNote.id;
    const matches = status === 'all' || nextNote.status === status;
    const idx = notes.findIndex((n) => n.id === id);
    if (!matches) {
      if (idx !== -1) notes.splice(idx, 1);
      return;
    }
    if (idx === -1) notes.unshift(nextNote);
    else notes[idx] = { ...notes[idx], ...nextNote };
  }

  async function load() {
    listEl.innerHTML = bootingHTML('正在取留言…');
    countEl.textContent = '…';
    try {
      const data = await api('/api/board?status=' + encodeURIComponent(status));
      if (seq !== seqCounter) return;
      notes = Array.isArray(data.notes) ? data.notes : [];
      loaded = true;
      renderTabs();
      renderNotes();
    } catch (err) {
      if (err.status === 401) return;
      loaded = false;
      listEl.innerHTML = `<div class="emptybox"><p>${esc(err.message || '留言板没打开')}</p>
        <div class="emptybox-actions"><button type="button" class="btn btn--primary" id="retry-board">再试一次</button></div></div>`;
      const retry = $('#retry-board', root);
      if (retry) retry.addEventListener('click', load);
    }
  }

  async function replyTo(note) {
    const current = note.reply && note.reply.body ? note.reply.body : '';
    const r = await modal({
      title: `答复 #${note.id}`,
      bodyHTML: `
        <p class="modal-text">${esc(String(note.body || '').slice(0, 120))}${String(note.body || '').length > 120 ? '…' : ''}</p>
        <label class="field">
          <span class="field-label">回话</span>
          <textarea id="reply-text" class="input textarea" maxlength="500" rows="4"
            placeholder="写点回话…">${esc(current)}</textarea>
          <span class="field-hint" id="reply-count"></span>
        </label>`,
      mount: (dlg) => {
        const ta = dlg.querySelector('#reply-text');
        const counter = dlg.querySelector('#reply-count');
        const sync = () => { counter.textContent = `${ta.value.length} / 500`; };
        ta.addEventListener('input', sync);
        sync();
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
      },
      read: (dlg) => dlg.querySelector('#reply-text').value.trim(),
      actions: [
        { label: '取消', value: 'cancel', kind: 'ghost' },
        { label: '发出去', value: 'ok', kind: 'primary' },
      ],
    });
    if (!r) return;
    if (!r.data) { toast('写一句话再发', 'warn'); return; }
    try {
      const res = await api('/api/board/reply', { method: 'POST', json: { id: note.id, body: r.data } });
      if (seq !== seqCounter) return;
      patchNote(res.note);
      renderNotes();
      toast('答复发出去了', 'ok');
    } catch (err) {
      if (err.status === 401) return;
      toast(err.message || '答复没发出去', 'err', 4200);
    }
  }

  async function toggleHide(note) {
    const hidden = note.status === 'hidden';
    try {
      const res = await api('/api/board/hide', { method: 'POST', json: { id: note.id, hidden: !hidden } });
      if (seq !== seqCounter) return;
      patchNote(res.note);
      renderNotes();
      toast(hidden ? '放回板子上了' : '盖起来了', 'ok');
    } catch (err) {
      if (err.status === 401) return;
      toast(err.message || '没改成', 'err', 4200);
    }
  }

  async function deleteNote(note) {
    const ok = await confirmAction({
      title: '真删掉这张便签？',
      message: `#${note.id} 删了就找不回来了。只是想收起来的话，用「隐藏」。`,
      okLabel: '删掉，不要了',
      danger: true,
    });
    if (!ok) return;
    try {
      await api('/api/board/delete', { method: 'POST', json: { id: note.id } });
      if (seq !== seqCounter) return;
      notes = notes.filter((n) => n.id !== note.id);
      renderNotes();
      toast('删掉了', 'ok');
    } catch (err) {
      if (err.status === 401) return;
      toast(err.message || '没删掉', 'err', 4200);
    }
  }

  listEl.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const card = btn.closest('.note');
    if (!card) return;
    const note = notes.find((n) => String(n.id) === String(card.dataset.id));
    if (!note) return;
    if (btn.dataset.act === 'reply') replyTo(note);
    else if (btn.dataset.act === 'hide') toggleHide(note);
    else if (btn.dataset.act === 'delete') deleteNote(note);
  });

  tabsEl.addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (!tab || tab.dataset.status === status) return;
    status = tab.dataset.status;
    loaded = false;
    renderTabs();
    load();
  });

  refreshBtn.addEventListener('click', load);

  renderTabs();
  await load();
};

/* ==========================================================================
   16. 入口
   ========================================================================== */

function init() {
  window.addEventListener('hashchange', () => {
    render().catch((err) => renderError(err));
  });
  render().catch((err) => renderError(err));

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {
        /* 装不上就算了，页面照常能用 */
      });
    });
  }
}

init();
