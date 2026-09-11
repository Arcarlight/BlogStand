#!/usr/bin/env node
/**
 * 星虹巢 · 本地编辑器（服务端）
 *
 * 只用 Node 内置模块，不需要 npm install。
 * 启动后在浏览器打开 http://127.0.0.1:4321/
 *
 * 能做的事：
 *   - 浏览 / 新建 / 编辑 / 删除 content 下的页面
 *   - 改 hugo.toml 的站点参数（保留注释，只动值）
 *   - 可视化编辑侧边栏的「友情链接」和「小按钮」
 *   - 管理 static/js 下的脚本，一键决定是否在网站上加载；也能挂外部脚本
 *   - 本地预览（自动起 hugo server，内嵌 iframe）
 *   - 一键 git 提交并推送
 */

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.EDITOR_PORT || 4321);
const TOKEN = crypto.randomBytes(16).toString('hex');
const TRASH = path.join(__dirname, 'trash');
const HUGO_PORT = 1313;
const MARK_BEGIN = '{{/* ==== EDITOR:SCRIPTS 开始（由编辑器管理，请勿手动改）==== */}}';
const MARK_END = '{{/* ==== EDITOR:SCRIPTS 结束 ==== */}}';

/* ============================================================
   基础工具
   ============================================================ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 用系统默认浏览器打开一个地址 */
function openBrowser(url) {
  if (process.env.EDITOR_NO_OPEN === '1') return;
  try {
    const opts = { detached: true, stdio: 'ignore', windowsHide: true };
    if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], opts).unref();
    else if (process.platform === 'darwin') spawn('open', [url], opts).unref();
    else spawn('xdg-open', [url], opts).unref();
  } catch { /* 打不开就算了，手动访问即可 */ }
}

function findHugo() {
  const guess = path.join(
    process.env.LOCALAPPDATA || '',
    'Microsoft', 'WinGet', 'Packages',
    'Hugo.Hugo.Extended_Microsoft.Winget.Source_8wekyb3d8bbwe', 'hugo.exe'
  );
  if (fs.existsSync(guess)) return guess;
  return 'hugo'; // 交给 PATH
}
const HUGO = findHugo();

/** 解析出项目内的绝对路径，并挡住越界访问 */
function safePath(rel) {
  const abs = path.resolve(ROOT, String(rel || '').replace(/^[\\/]+/, ''));
  if (!abs.startsWith(ROOT + path.sep) && abs !== ROOT) throw new Error('路径越界: ' + rel);
  return abs;
}

async function readText(rel) {
  return await fsp.readFile(safePath(rel), 'utf8');
}
async function writeText(rel, text) {
  const abs = safePath(rel);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, text, 'utf8');
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
      windowsHide: true, ...opts,
    }, (err, stdout, stderr) => {
      resolve({
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        stdout: stdout || '',
        stderr: stderr || '',
      });
    });
  });
}

const git = (args) => run('git', args);

/* ============================================================
   hugo server（预览用）
   ============================================================ */

let hugoProc = null;

async function hugoAlive() {
  try {
    const ctl = AbortSignal.timeout(1500);
    const r = await fetch(`http://127.0.0.1:${HUGO_PORT}/`, { signal: ctl });
    return r.status === 200;
  } catch { return false; }
}

async function hugoStart() {
  if (await hugoAlive()) return { ok: true, note: '已经在跑了' };
  try {
    hugoProc = spawn(HUGO,
      ['server', '-D', '--bind', '127.0.0.1', '--port', String(HUGO_PORT),
       '--disableFastRender', '--logLevel', 'warn'],
      { cwd: ROOT, shell: true, stdio: 'ignore', windowsHide: true });
  } catch (e) {
    return { ok: false, note: '启动失败: ' + e.message };
  }
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    if (await hugoAlive()) return { ok: true, note: '已启动' };
  }
  return { ok: false, note: '启动超时，看看 hugo 能不能在命令行里跑起来' };
}

async function hugoStop() {
  if (hugoProc && hugoProc.pid) {
    await run('taskkill', ['/PID', String(hugoProc.pid), '/T', '/F']);
    hugoProc = null;
  }
  // 兜底：把监听 1313 的 hugo 都收掉
  await run('powershell', ['-NoProfile', '-Command',
    "Get-Process hugo -ErrorAction SilentlyContinue | Stop-Process -Force"]);
  await sleep(400);
  return { ok: !(await hugoAlive()) };
}

/* ============================================================
   文件树
   ============================================================ */

const isMd = (f) => f.endsWith('.md');

async function listDir(rel) {
  try {
    const out = [];
    for (const e of await fsp.readdir(safePath(rel), { withFileTypes: true })) {
      if (e.name.startsWith('.') || e.name.startsWith('_')) continue;
      const r = path.posix.join(rel, e.name);
      if (e.isDirectory()) out.push(...await listDir(r));
      else out.push(r);
    }
    return out;
  } catch { return []; }
}

async function buildTree() {
  const tree = [];

  const statics = [
    'content/_index.md', 'content/self_intros.md', 'content/navigator.md',
    'content/gallery.md', 'content/tobitaiaaken.md', 'content/ihsobijin2006.md',
  ];
  tree.push({
    group: '首页与单页', kind: 'content',
    files: (await Promise.all(statics.map(async (f) =>
      (await fsp.stat(safePath(f)).catch(() => null)) ? f : null))).filter(Boolean),
  });

  const blog = (await listDir('content/blog')).filter(isMd).sort();
  tree.push({ group: '博客', kind: 'content', files: blog });

  const niki = (await listDir('content/niki')).filter(isMd).sort();
  tree.push({ group: '日记', kind: 'content', files: niki });

  tree.push({ group: '站点设置', kind: 'config', files: ['hugo.toml'] });

  tree.push({
    group: '侧边栏数据', kind: 'data',
    files: ['data/links.toml', 'data/buttons.toml'],
    special: { 'data/links.toml': 'links', 'data/buttons.toml': 'buttons' },
  });

  const js = (await listDir('static/js')).filter((f) => f.endsWith('.js')).sort();
  tree.push({ group: '脚本 JS', kind: 'js', files: js });

  tree.push({
    group: '模板与样式', kind: 'template',
    files: [
      'layouts/baseof.html', 'layouts/home.html', 'layouts/list.html',
      'layouts/single.html', 'layouts/404.html', 'layouts/rss.xml',
      'layouts/_partials/header.html', 'layouts/_partials/sidebar.html',
      'layouts/_partials/footer.html', 'layouts/_partials/head.html',
      'layouts/_partials/post-meta.html', 'layouts/_partials/pager.html',
      'layouts/_partials/comments.html',
      'assets/css/retro.css',
    ],
  });

  return tree;
}

/* ============================================================
   hugo.toml 参数：只改值，保留注释
   ============================================================ */

function splitValueComment(rest) {
  let inStr = false, esc = false;
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (c === '#' && !inStr) return [rest.slice(0, i), rest.slice(i)];
  }
  return [rest, ''];
}

function parseParams(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^\s*\[params\]\s*$/.test(l));
  if (start < 0) return { order: [], items: {} };
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i])) { end = i; break; }
  }
  const items = {}, order = [];
  for (let i = start + 1; i < end; i++) {
    const m = lines[i].match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    const [rawVal, comment] = splitValueComment(m[2]);
    const v = rawVal.trim();
    let type = 'string', value = v;
    if (/^"(.*)"$/s.test(v)) { type = 'string'; value = v.slice(1, -1).replace(/\\"/g, '"'); }
    else if (v === 'true' || v === 'false') { type = 'bool'; value = v === 'true'; }
    else { type = 'raw'; value = v; }
    items[m[1]] = { type, value, comment: comment.trim() };
    order.push(m[1]);
  }
  return { order, items };
}

function serializeParam(v) {
  if (v && typeof v === 'object' && 'type' in v) {
    if (v.type === 'bool') return v.value ? 'true' : 'false';
    return '"' + String(v.value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  }
  return v;
}

function setParams(text, updates) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^\s*\[params\]\s*$/.test(l));
  if (start < 0) throw new Error('hugo.toml 里找不到 [params] 段');
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i])) { end = i; break; }
  }
  const seen = new Set();
  for (let i = start + 1; i < end; i++) {
    const m = lines[i].match(/^(\s*)([A-Za-z0-9_]+)(\s*=\s*)(.*)$/);
    if (!m) continue;
    const key = m[2];
    if (!Object.prototype.hasOwnProperty.call(updates, key)) continue;
    const [rawVal, comment] = splitValueComment(m[4]);
    const tail = (comment ? '  ' + comment.trim() : '');
    lines[i] = `${m[1]}${key}${m[3]}${serializeParam(updates[key])}${tail}`;
    seen.add(key);
  }
  const added = Object.keys(updates).filter((k) => !seen.has(k));
  if (added.length) {
    lines.splice(end, 0, '', '# 下面这些是编辑器补上的',
      ...added.map((k) => `${k} = ${serializeParam(updates[k])}`));
  }
  return lines.join('\n');
}

/* ============================================================
   data/*.toml 的 [[items]] 列表
   ============================================================ */

function parseItems(text) {
  const items = [];
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t === '[[items]]') { cur = {}; items.push(cur); continue; }
    if (!cur) continue;
    const m = t.match(/^([A-Za-z0-9_]+)\s*=\s*"(.*)"\s*$/);
    if (m) cur[m[1]] = m[2].replace(/\\"/g, '"');
  }
  return items;
}

function writeItems(header, items, keys) {
  const out = [header.trimEnd(), ''];
  for (const it of items) {
    out.push('[[items]]');
    for (const k of keys) {
      const v = String(it[k] ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      out.push(`  ${k} = "${v}"`);
    }
    out.push('');
  }
  return out.join('\n');
}

const LINKS_HEADER = `# ============================================================
#  友情链接 —— 侧边栏挂件读取这个文件
#  （用本地编辑器改的话，这段注释会自动保留）
# ============================================================`;
const BUTTONS_HEADER = `# ============================================================
#  88×31 小按钮
#  全部由 CSS 现场画出来，不需要准备图片文件
# ============================================================`;

/* ============================================================
   脚本管理
   ============================================================ */

function scriptBlock(entries) {
  const body = entries.map((e) =>
    e.type === 'local'
      ? `<script src="{{ "${e.src}" | relURL }}"${e.defer ? ' defer' : ''}></script>`
      : `<script src="${e.src}"${e.defer ? ' defer' : ''}></script>`
  );
  return [MARK_BEGIN, ...body, MARK_END].join('\n');
}

function readScriptBlock(baseof) {
  const i = baseof.indexOf(MARK_BEGIN);
  const j = baseof.indexOf(MARK_END);
  if (i < 0 || j < 0) return [];
  const inner = baseof.slice(i + MARK_BEGIN.length, j);
  const out = [];
  for (const m of inner.matchAll(/<script\s+src=(?:"([^"]*)"|'([^']*)')[^>]*?>/g)) {
    const src = m[1] ?? m[2] ?? '';
    const tag = m[0];
    const defer = /\sdefer\b/.test(tag);
    const local = src.match(/^\{\{\s*"([^"]+)"\s*\|\s*relURL\s*\}\}$/);
    out.push(local ? { type: 'local', src: local[1], defer } : { type: 'external', src, defer });
  }
  return out;
}

function writeScriptBlock(baseof, entries) {
  const block = scriptBlock(entries);
  const i = baseof.indexOf(MARK_BEGIN);
  const j = baseof.indexOf(MARK_END);
  if (i >= 0 && j >= 0) return baseof.slice(0, i) + block + baseof.slice(j + MARK_END.length);
  // 第一次：插到 </body> 前面
  const k = baseof.lastIndexOf('</body>');
  const insert = '\n' + block + '\n';
  return k >= 0 ? baseof.slice(0, k) + insert + baseof.slice(k) : baseof + insert;
}

async function getScripts() {
  const tree = await buildTree();
  const jsGroup = tree.find((g) => g.kind === 'js');
  const files = jsGroup ? jsGroup.files.map((f) => path.basename(f)) : [];

  const baseofPath = 'layouts/baseof.html';
  let baseof = '';
  try { baseof = await readText(baseofPath); } catch { }

  const inBlock = readScriptBlock(baseof);
  const blockNames = inBlock
    .filter((e) => e.type === 'local')
    .map((e) => e.src.replace(/^js\//, ''));

  // 模板里被写死引用的脚本（内置脚本，比如 retro.js / sparkle.js）
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const outside = baseof.replace(
    new RegExp(escapeRe(MARK_BEGIN) + '[\\s\\S]*?' + escapeRe(MARK_END)), '');
  const builtin = new Set();
  for (const m of outside.matchAll(/\{\{\s*"(js\/[^"]+)"\s*\|\s*relURL\s*\}\}/g)) {
    builtin.add(m[1].replace(/^js\//, ''));
  }

  return {
    files,
    loaded: [...new Set([...blockNames, ...builtin])],
    builtin: [...builtin],
    external: inBlock.filter((e) => e.type === 'external'),
  };
}

/* ============================================================
   请求处理
   ============================================================ */

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 16 * 1024 * 1024) throw new Error('内容太大了');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function handle(req, res, url) {
  const p = url.pathname;

  /* ---------- 静态页面 ---------- */
  if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
    let html = await fsp.readFile(path.join(__dirname, 'ui.html'), 'utf8');
    html = html.replace(/__TOKEN__/g, TOKEN);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(html);
  }

  if (!p.startsWith('/api/')) { json(res, 404, { error: 'not found' }); return; }

  /* ---------- 简易 CSRF 防护 ---------- */
  if (req.headers['x-editor-token'] !== TOKEN) { json(res, 403, { error: '令牌不对' }); return; }

  /* ---------- 路由 ---------- */
  if (p === '/api/bootstrap' && req.method === 'GET') {
    const alive = await hugoAlive();
    let gitStatus = [], gitLog = [];
    const s = await git(['status', '--porcelain']);
    gitStatus = s.stdout.split('\n').map((x) => x.trimEnd()).filter(Boolean);
    const l = await git(['log', '-8', '--pretty=format:%h\t%ad\t%s', '--date=format:%m-%d']);
    gitLog = l.stdout.split('\n').filter(Boolean);
    return json(res, 200, {
      root: ROOT,
      hugo: HUGO,
      previewUrl: `http://127.0.0.1:${HUGO_PORT}/`,
      hugoRunning: alive,
      tree: await buildTree(),
      gitStatus, gitLog,
    });
  }

  if (p === '/api/file' && req.method === 'GET') {
    const rel = url.searchParams.get('p');
    const text = await readText(rel);
    return json(res, 200, { p: rel, text });
  }

  if (p === '/api/file' && req.method === 'POST') {
    const { p: rel, text } = await readBody(req);
    await writeText(rel, text);
    return json(res, 200, { ok: true });
  }

  if (p === '/api/new' && req.method === 'POST') {
    const { kind, name, title, date } = await readBody(req);
    const clean = String(name || '').trim().replace(/[\\/:*?"<>|]/g, '');
    if (!clean) throw new Error('文件名不能为空');
    const d = date || new Date().toISOString().slice(0, 10);

    let rel, body;
    if (kind === 'blog') {
      rel = `content/blog/${clean}.md`;
      body = `---\ntitle: "${title}"\ndate: ${d}\ndraft: false\ntags: []\ndescription: ""\n---\n\n在这里写正文。\n`;
    } else if (kind === 'niki') {
      rel = `content/niki/${clean}.md`;
      body = `---\ntitle: "${title}"\ndate: ${d}\ndraft: false\ndescription: ""\n---\n\n在这里写日记。\n`;
    } else {
      rel = `content/${clean}.md`;
      body = `---\ntitle: "${title}"\ndraft: false\ndescription: ""\n---\n\n在这里写内容。\n`;
    }
    if (await fsp.stat(safePath(rel)).catch(() => null)) throw new Error('文件已存在: ' + rel);
    await writeText(rel, body);
    return json(res, 200, { ok: true, p: rel });
  }

  if (p === '/api/delete' && req.method === 'POST') {
    const { p: rel } = await readBody(req);
    const abs = safePath(rel);
    await fsp.mkdir(TRASH, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(TRASH, `${stamp}__${path.basename(abs)}`);
    await fsp.rename(abs, dest);
    return json(res, 200, { ok: true, trashed: dest });
  }

  if (p === '/api/params' && req.method === 'GET') {
    return json(res, 200, parseParams(await readText('hugo.toml')));
  }
  if (p === '/api/params' && req.method === 'POST') {
    const { updates } = await readBody(req);
    const next = setParams(await readText('hugo.toml'), updates);
    await writeText('hugo.toml', next);
    return json(res, 200, parseParams(next));
  }

  if (p.startsWith('/api/list/')) {
    const which = p.split('/')[3];
    const rel = which === 'links' ? 'data/links.toml' : 'data/buttons.toml';
    const keys = which === 'links' ? ['name', 'url', 'desc'] : ['line1', 'line2', 'url', 'bg', 'fg'];
    const header = which === 'links' ? LINKS_HEADER : BUTTONS_HEADER;
    if (req.method === 'GET') return json(res, 200, { items: parseItems(await readText(rel)), keys });
    const { items } = await readBody(req);
    await writeText(rel, writeItems(header, items, keys));
    return json(res, 200, { ok: true });
  }

  if (p === '/api/scripts' && req.method === 'GET') return json(res, 200, await getScripts());

  if (p === '/api/scripts/save' && req.method === 'POST') {
    const { name, text } = await readBody(req);
    const clean = String(name).replace(/[\\/:*?"<>|]/g, '');
    if (!/\.js$/i.test(clean)) throw new Error('文件名要以 .js 结尾');
    await writeText('static/js/' + clean, text);
    return json(res, 200, { ok: true });
  }

  if (p === '/api/scripts/delete' && req.method === 'POST') {
    const { name } = await readBody(req);
    const abs = safePath('static/js/' + name);
    await fsp.mkdir(TRASH, { recursive: true });
    await fsp.rename(abs, path.join(TRASH, `${Date.now()}__${path.basename(abs)}`));
    const baseof = await readText('layouts/baseof.html');
    const entries = readScriptBlock(baseof).filter((e) => e.src !== 'js/' + name);
    await writeText('layouts/baseof.html', writeScriptBlock(baseof, entries));
    return json(res, 200, { ok: true });
  }

  if (p === '/api/scripts/toggle' && req.method === 'POST') {
    const { name, on } = await readBody(req);
    const info = await getScripts();
    if (info.builtin.includes(name)) {
      return json(res, 400, { error: '这是内置脚本，由 layouts/baseof.html 直接引入，不能在这里开关' });
    }
    const baseof = await readText('layouts/baseof.html');
    let entries = readScriptBlock(baseof);
    const target = 'js/' + name;
    entries = entries.filter((e) => e.src !== target);
    if (on) entries.push({ type: 'local', src: target, defer: true });
    await writeText('layouts/baseof.html', writeScriptBlock(baseof, entries));
    return json(res, 200, await getScripts());
  }

  if (p === '/api/scripts/external' && req.method === 'POST') {
    const { urls } = await readBody(req);
    const baseof = await readText('layouts/baseof.html');
    const locals = readScriptBlock(baseof).filter((e) => e.type === 'local');
    const entries = [...locals, ...urls.filter(Boolean).map((u) => ({ type: 'external', src: u, defer: true }))];
    await writeText('layouts/baseof.html', writeScriptBlock(baseof, entries));
    return json(res, 200, await getScripts());
  }

  if (p === '/api/git' && req.method === 'GET') {
    const s = await git(['status', '--porcelain']);
    const l = await git(['log', '-8', '--pretty=format:%h\t%ad\t%s', '--date=format:%m-%d']);
    return json(res, 200, {
      status: s.stdout.split('\n').map((x) => x.trimEnd()).filter(Boolean),
      log: l.stdout.split('\n').filter(Boolean),
    });
  }

  if (p === '/api/git' && req.method === 'POST') {
    const { action, message } = await readBody(req);
    const steps = [];
    if (action === 'commit' || action === 'commitpush') {
      steps.push(await git(['add', '-A']));
      const st = await git(['status', '--porcelain']);
      if (!st.stdout.trim()) return json(res, 200, { ok: true, quiet: true, steps, note: '没有需要提交的改动' });
      steps.push(await git(['commit', '-m', message || '更新']));
    }
    if (action === 'push' || action === 'commitpush') {
      steps.push(await git(['push', 'origin', 'main']));
    }
    const bad = steps.find((s) => s.code !== 0);
    return json(res, 200, {
      ok: !bad,
      steps: steps.map((s) => ({ code: s.code, out: (s.stdout + s.stderr).trim() })),
    });
  }

  if (p === '/api/hugo' && req.method === 'POST') {
    const { action } = await readBody(req);
    if (action === 'start') return json(res, 200, await hugoStart());
    if (action === 'stop') return json(res, 200, await hugoStop());
    if (action === 'build') {
      const r = await run(HUGO, ['--gc', '--minify', '--logLevel', 'warn']);
      return json(res, 200, { ok: r.code === 0, out: (r.stdout + r.stderr).trim() });
    }
    if (action === 'status') return json(res, 200, { running: await hugoAlive() });
  }

  json(res, 404, { error: '未知接口 ' + p });
}

/* ============================================================
   启动
   ============================================================ */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  // 只接受本机来源
  const origin = req.headers.origin;
  if (origin && !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin)) {
    return json(res, 403, { error: '来源不允许' });
  }
  try {
    await handle(req, res, url);
  } catch (e) {
    json(res, 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, '127.0.0.1', async () => {
  // git 的一些设置，避免中文乱码
  await git(['config', 'core.quotepath', 'false']);
  await git(['config', 'i18n.commitEncoding', 'utf-8']);

  console.log('');
  console.log('  ╔══════════════════════════════════════════════╗');
  console.log('  ║   星虹巢 · 本地编辑器                        ║');
  console.log('  ╚══════════════════════════════════════════════╝');
  console.log('');
  console.log('   地址:  http://127.0.0.1:' + PORT + '/');
  console.log('   项目:  ' + ROOT);
  console.log('   hugo:  ' + HUGO);
  console.log('');
  console.log('   关掉这个窗口 = 停止编辑器。');
  console.log('');

  const r = await hugoStart();
  console.log('   预览服务器: ' + r.note + '  http://127.0.0.1:' + HUGO_PORT + '/');
  console.log('');

  openBrowser(`http://127.0.0.1:${PORT}/`);
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n  端口 ${PORT} 被占用了，可能是编辑器已经在跑。`);
    console.error('   直接打开 http://127.0.0.1:' + PORT + '/ 试试；');
    console.error('   或者设一个别的端口:  set EDITOR_PORT=4322 && node server.mjs\n');
  } else {
    console.error(e);
  }
  process.exit(1);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => { await hugoStop(); process.exit(0); });
}
