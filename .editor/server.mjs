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
import { spawn, execFile, execFileSync } from 'node:child_process';
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

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

function findHugo() {
  // 各个系统上常见的安装位置先看一眼（有完整路径就不用 shell:true，
  // 也就没有 Node 的 DEP0190 警告）
  const guesses = IS_WIN
    ? [path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages',
        'Hugo.Hugo.Extended_Microsoft.Winget.Source_8wekyb3d8bbwe', 'hugo.exe')]
    : [
        // macOS：Homebrew（Apple 芯片 / Intel）、MacPorts
        '/opt/homebrew/bin/hugo', '/usr/local/bin/hugo', '/opt/local/bin/hugo',
        // Linux
        '/snap/bin/hugo', '/usr/bin/hugo', '/usr/local/bin/hugo',
      ];
  for (const g of guesses) if (g && fs.existsSync(g)) return g;
  // 再去 PATH 里找：Windows 用 where、macOS/Linux 用 which
  try {
    const out = execFileSync(IS_WIN ? 'where' : 'which', ['hugo'],
      { encoding: 'utf8', windowsHide: true });
    const first = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    if (first && fs.existsSync(first)) return first;
  } catch { /* 找不到就算了 */ }
  return 'hugo';
}
const HUGO = findHugo();

/** hugo 到底能不能跑（找不到就只影响预览/构建/发布，编辑照常） */
let hugoOk = false;
try {
  execFileSync(HUGO, ['version'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  hugoOk = true;
} catch { /* 没装或者不在 PATH 里 */ }

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

/* ---------- 访问日志（排查问题用）---------- */
const ACCESS_LOG = path.join(__dirname, 'access.log');
function logAccess(line) {
  try { fs.appendFileSync(ACCESS_LOG, line + '\n'); } catch { /* 写不了就算了 */ }
}
try { fs.writeFileSync(ACCESS_LOG, `--- 编辑器启动 ${new Date().toISOString()} ---\n`); } catch { }

/** 看看指定端口上跑的是不是我们自己 */
async function pingExisting(port = PORT) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return null;
    const j = await r.json();
    return j && j.app === 'hoshi-editor' ? j : null;
  } catch { return null; }
}

/* ============================================================
   hugo server（预览用）
   ============================================================ */

let hugoProc = null;
let hugoLog = '';
let hugoUrl = `http://127.0.0.1:${HUGO_PORT}/`;

const tail = (s, n = 4000) => (s.length > n ? '…' + s.slice(-n) : s);

async function probe(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return r.status;
  } catch { return 0; }
}

async function hugoAlive(url = hugoUrl) {
  return (await probe(url)) === 200;
}

async function hugoStart() {
  if (await hugoAlive()) return { ok: true, note: '已经在运行', url: hugoUrl };

  hugoLog = '';
  hugoUrl = `http://127.0.0.1:${HUGO_PORT}/`;

  // 关键：必须显式给 dev server 一个不带子路径的 --baseURL。
  // 否则 hugo.toml 里的 https://xxx.github.io/BlogStand/ 会被继承，
  // dev server 就会跑到 /BlogStand/ 下面去，预览根路径 404。
  const args = [
    'server', '-D',
    '--bind', '127.0.0.1',
    '--port', String(HUGO_PORT),
    '--baseURL', `http://127.0.0.1:${HUGO_PORT}/`,
    '--disableFastRender',
    '--logLevel', 'warn',
  ];

  let exited = null;
  try {
    hugoProc = spawn(HUGO, args, {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
  } catch (e) {
    return { ok: false, note: '启动失败: ' + e.message, url: hugoUrl };
  }
  hugoProc.on('exit', (c) => { exited = (c === null ? -1 : c); });
  hugoProc.on('error', (e) => { hugoLog += '\n[spawn error] ' + e.message; });

  const onData = (d) => {
    hugoLog = tail(hugoLog + d.toString(), 8000);
    const m = hugoLog.match(/Web Server is available at (\S+)/i);
    if (m) hugoUrl = m[1].replace(/\/+$/, '') + '/';
  };
  hugoProc.stdout.on('data', onData);
  hugoProc.stderr.on('data', onData);

  for (let i = 0; i < 60; i++) {          // 最多等 30 秒
    await sleep(500);
    if (exited !== null) {
      return { ok: false, note: `hugo 启动后立刻退出了（code ${exited}）`, log: hugoLog.trim(), url: hugoUrl };
    }
    if (await hugoAlive()) {
      return { ok: true, note: '已启动', url: hugoUrl, log: hugoLog.trim() };
    }
  }
  return { ok: false, note: '启动超时（30 秒）', log: hugoLog.trim(), url: hugoUrl };
}

async function hugoStop() {
  if (hugoProc && hugoProc.pid) {
    if (IS_WIN) {
      await run('taskkill', ['/PID', String(hugoProc.pid), '/T', '/F']);
    } else {
      // macOS / Linux：hugo server 是单个进程，先好好请它退，赖着不走再强杀
      try { process.kill(hugoProc.pid, 'SIGTERM'); } catch { /* 已经没了 */ }
      await sleep(300);
      try { process.kill(hugoProc.pid, 'SIGKILL'); } catch { /* 已经没了 */ }
    }
    hugoProc = null;
  }
  // 兜底：还有别的 hugo 占着端口就一并收掉
  if (IS_WIN) {
    await run('powershell', ['-NoProfile', '-Command',
      'Get-Process hugo -ErrorAction SilentlyContinue | Stop-Process -Force']);
  } else {
    await run('pkill', ['-f', 'hugo server']);
  }
  await sleep(400);
  hugoUrl = `http://127.0.0.1:${HUGO_PORT}/`;
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

/* ---------- 侧栏自定义排序 ----------
   左侧列表可以用鼠标拖动排序，顺序存在 .editor/order.json 里
   （按「分组名 -> 文件路径数组」存）。这只是编辑器自己的显示顺序，
   不影响站点本身，所以那个文件加进了 .gitignore，不进版本库。 */
const ORDER_FILE = '.editor/order.json';
let ORDER_CACHE = null;

async function readOrder() {
  if (ORDER_CACHE) return ORDER_CACHE;
  try {
    ORDER_CACHE = JSON.parse(await fsp.readFile(safePath(ORDER_FILE), 'utf8')) || {};
  } catch { ORDER_CACHE = {}; }
  return ORDER_CACHE;
}

/** 按保存的顺序重排。没记录过的文件（比如刚新建的）排到后面，
 *  它们之间保持传进来的原顺序 —— Array#sort 在 Node 里是稳定的。 */
function applyOrder(files, saved) {
  if (!Array.isArray(saved) || !saved.length) return files;
  const idx = new Map(saved.map((f, i) => [f, i]));
  return files.slice().sort((a, b) => {
    const ia = idx.has(a) ? idx.get(a) : Number.MAX_SAFE_INTEGER;
    const ib = idx.has(b) ? idx.get(b) : Number.MAX_SAFE_INTEGER;
    return ia - ib;
  });
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

  // 草稿单独抽出来放最前面
  const allContent = tree.filter((g) => g.kind === 'content').flatMap((g) => g.files);
  const drafts = [];
  for (const f of allContent) {
    try {
      const t = await readText(f);
      const fm = t.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (fm && /^draft:\s*true\s*$/m.test(fm[1])) drafts.push(f);
    } catch { /* 读不了就跳过 */ }
  }
  if (drafts.length) {
    tree.unshift({ group: `草稿（${drafts.length}）`, kind: 'content', files: drafts, draft: true });
  }

  // 应用侧栏自定义排序（草稿组不参与：它的成员会随草稿开关变，排了也没意义）
  const order = await readOrder();
  for (const g of tree) {
    if (g.draft) continue;
    g.files = applyOrder(g.files, order[g.group]);
  }

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
const UPDATES_HEADER = `# ============================================================
#  更新通报 —— 侧栏和首页的「更新日志」读取这个文件
#
#  这里只放「手动加的通报」。页面、博客、日记的更新是构建时自动收的
#  （按 git 提交日期取最近更新的页面），不用在这里登记。
#  用本地编辑器左侧「更新日志」面板改最省事，注释会自动保留。
#
#    date   = "2026-09-12"      必填，YYYY-MM-DD（写错构建会报错）
#    title  = "换了新的点阵字体"  必填
#    url    = "/blog/xxx/"      可空，填了就变成链接
# ============================================================`;

const NOTICES_HEADER = `# ============================================================
#  公告栏 —— 侧栏上那块「公告」
#
#  和顶部那条滚动公告不是一回事：
#    · 顶部滚动条：hugo.toml 里的 notice，一句话循环滚过去
#    · 这里：一条一条挂着，带日期，最近几天加的会挂 NEW 牌子
#
#  用本地编辑器左侧「公告栏」面板改最省事，注释会自动保留。
#
#    date   = "2026-09-13"      必填，YYYY-MM-DD（写错构建会报错）
#    text   = "本站刚搬完家"      必填
#    url    = "/blog/xxx/"      可空，填了就变成链接
# ============================================================`;

/* 侧栏挂件：key 是 partial 文件名，label 是给编辑器显示的名字。
   这份表要和 layouts/_partials/sidebar.html 里的 $default 保持一致。 */
const SIDEBAR_WIDGETS = [
  ['notices',  '公告栏'],
  ['about',    '关于站长'],
  ['search',   '站内搜索'],
  ['tags',     '标签云'],
  ['recent',   '最新博客'],
  ['updates',  '更新日志'],
  ['links',    '友情链接'],
  ['visitors', '访客统计'],
  ['clock',    '现在时间'],
  ['hitokoto', '一言'],
  ['pasture',  '宝可梦放养区'],
  ['buttons',  '小按钮'],
];

const SIDEBAR_HEADER = `# ============================================================
#  侧栏挂件的顺序
#
#  由编辑器左侧的「侧栏排序」面板拖动生成，手改也行。
#  挂件名不能乱写，认得的只有这些（写错的会被忽略）：
#
#    notices    公告栏        about      关于站长
#    search     站内搜索      tags       标签云
#    recent     最新博客      updates    更新日志
#    links      友情链接      visitors   访客统计
#    clock      现在时间      hitokoto   一言
#    pasture    宝可梦放养区  buttons    小按钮
#
#  没列到的挂件会自动补在最后，所以新加的挂件不会凭空消失。
# ============================================================`;

function parseSidebarOrder(text) {
  const m = text.match(/^\s*order\s*=\s*\[([^\]]*)\]/m);
  if (!m) return [];
  return m[1].split(',').map((s) => s.trim().replace(/^"|"$/g, '')).filter(Boolean);
}

function writeSidebarOrder(order) {
  const keys = order.filter((k) => SIDEBAR_WIDGETS.some((w) => w[0] === k));
  return SIDEBAR_HEADER + '\norder = [' + keys.map((k) => `"${k}"`).join(', ') + ']\n';
}

/* data/*.toml 里那几张 [[items]] 列表：接口 /api/list/<key> 用这张表 */
const DATA_LISTS = {
  links:   { file: 'data/links.toml',   keys: ['name', 'url', 'desc'],               header: LINKS_HEADER },
  buttons: { file: 'data/buttons.toml', keys: ['line1', 'line2', 'url', 'bg', 'fg'], header: BUTTONS_HEADER },
  updates: { file: 'data/updates.toml', keys: ['date', 'title', 'url'],              header: UPDATES_HEADER },
  notices: { file: 'data/notices.toml', keys: ['date', 'text', 'url'],               header: NOTICES_HEADER },
};

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
   日记：日历生成 / 和風月名 / 导航页同步
   ============================================================ */

const MONTH_INFO = {
  1:  ['睦月',   '新春将至 万象更新'],
  2:  ['如月',   '草木更生 新年到来'],
  3:  ['弥生月', '万物复苏 春来花开'],
  4:  ['卯月',   '天高云清 雨露丰裕'],
  5:  ['皐月',   '云转天变 时雨时晴'],
  6:  ['水無月', '雨水倾覆 日日云墨'],
  7:  ['文月',   '风雨飘摇 冷雨湿涟'],
  8:  ['叶月',   '日悬晴天 酷夏炎炎'],
  9:  ['長月',   '秋雨连绵 云沉满天'],
  10: ['神無月', '秋高气爽 红叶满山'],
  11: ['霜月',   '寒意渐浓 红叶飘零'],
  12: ['師走',   '岁末将至 一年将尽'],
};

const daysInMonth = (y, m) => new Date(y, m, 0).getDate();
const firstWeekday = (y, m) => new Date(y, m - 1, 1).getDay(); // 0 = 日曜

/** 生成日历表格。linkFn(day) 返回该格的 HTML（纯文本或 <a>） */
function calendarTable(y, m, linkFn) {
  const cells = [];
  for (let i = 0; i < firstWeekday(y, m); i++) cells.push(null);
  for (let d = 1; d <= daysInMonth(y, m); d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);

  const L = [];
  L.push('<table>');
  L.push('<thead>');
  L.push('<tr>');
  for (const w of ['日', '月', '火', '水', '木', '金', '土']) L.push(`  <th>${w}</th>`);
  L.push('</tr>');
  L.push('</thead>');
  L.push('<tbody>');
  for (let r = 0; r < cells.length; r += 7) {
    L.push('<tr>');
    for (let c = 0; c < 7; c++) {
      const d = cells[r + c];
      L.push('  <td>' + (d ? linkFn(d) : '--') + '</td>');
    }
    L.push('</tr>');
  }
  L.push('</tbody>');
  L.push('</table>');
  return L.join('\n');
}

/** 新建日记时的正文骨架 */
function diaryTemplate(y, m, opts = {}) {
  const key = `${y}${String(m).padStart(2, '0')}`;
  const mm = String(m).padStart(2, '0');
  const [kana, phrase] = MONTH_INFO[m];
  const L = [];
  if (opts.headImage) L.push(`<p><img src="${opts.headImage}" alt="日记头图" /></p>`);
  L.push('<center>');
  L.push(`${y}年 ${m}月`);
  L.push('</center>');
  // 日历表不再写死在这里：短代码会在构建时扫本页的 <span id="MMDD"> 锚点自己生成，
  // 日记页和导航页共用这一份，以后加日期不用再手动改表。
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

/** 新建月份时，往导航页插的那一块 */
function navigatorBlock(y, m, days) {
  const key = `${y}${String(m).padStart(2, '0')}`;
  const mm = String(m).padStart(2, '0');
  const [kana, phrase] = MONTH_INFO[m];
  const link = (d) => {
    const dd = String(d).padStart(2, '0');
    return days.has(dd)
      ? `<a href='/niki/niki_${key}/#${mm}${dd}'>${d}日</a>`
      : `${d}日`;
  };
  return [
    '<center>',
    `${y}年 ${m}月`,
    '</center>',
    calendarTable(y, m, link),
    '<br>',
    '<center>',
    `<b>${kana} ${phrase}</b>`,
    '</center>',
    '<br>',
  ].join('\n');
}

/** 扫描 content/niki 下每篇日记的日期锚点 */
async function collectDiaryAnchors() {
  const map = new Map(); // 'YYYYMM' -> { year, month, days:Set('DD') }
  let files = [];
  try {
    files = (await fsp.readdir(safePath('content/niki'))).filter((f) => /^niki_\d{6}\.md$/.test(f));
  } catch { return map; }

  for (const f of files) {
    const m = f.match(/^niki_(\d{4})(\d{2})\.md$/);
    if (!m) continue;
    const key = m[1] + m[2];
    const txt = await readText('content/niki/' + f);
    const set = new Set();
    for (const a of txt.matchAll(/<span\s+id=["'](\d{2})(\d{2})["']/g)) set.add(a[2]);
    map.set(key, { year: +m[1], month: +m[2], days: set });
  }
  return map;
}

/** 把导航页的日历跟日记里的锚点对齐，缺的月份补上。
 *  opts.prune = true 时才会移除导航页里多出来的链接（默认保留手工加的）
 *
 *  ⚠️ 2026-09-12 起已经**没有调用方**了：导航页的日历改由 Hugo 短代码
 *  `{{< niki-cal-all >}}` 在构建时生成（layouts/_shortcodes/niki-cal-all.html），
 *  正文里不再保存任何日历表。这套手工同步的代码先留着，万一要退回旧做法
 *  还能用；直接调用它会把静态表格重新写进 navigator.md，跟短代码的表格
 *  同时出现在页面上，所以**别再接到接口上**。 */
async function syncNavigator(opts = {}) {
  const prune = !!opts.prune;
  const anchors = await collectDiaryAnchors();
  const nav = await readText('content/navigator.md');

  const fmMatch = nav.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
  const fmText = fmMatch ? fmMatch[0] : '';
  const body = nav.slice(fmText.length);

  // 注意：导航页里 <hr> 和 <hr /> 两种写法混着用，都要认
  const parts = body.split(/\r?\n<hr\s*\/?>\r?\n/);
  const intro = parts[0];
  const parsed = [];

  for (const b of parts.slice(1)) {
    // 一块里可能只有一个月；但如果分隔没切开，就把所有月份都找出来
    const months = [...b.matchAll(/<center>\s*(\d{4})年\s*(\d{1,2})月\s*<\/center>/g)];
    if (months.length <= 1) {
      parsed.push(months.length
        ? { raw: b, year: +months[0][1], month: +months[0][2] }
        : { raw: b, year: null });
    } else {
      // 兜底：按月份标题切开，各自成块（防止分隔符异常时重复添加）
      let cursor = 0;
      for (let i = 0; i < months.length; i++) {
        const start = months[i].index;
        const end = i + 1 < months.length ? months[i + 1].index : b.length;
        if (i === 0 && start > 0) parsed.push({ raw: b.slice(0, start), year: null });
        parsed.push({ raw: b.slice(start, end), year: +months[i][1], month: +months[i][2] });
        cursor = end;
      }
      if (cursor < b.length) parsed.push({ raw: b.slice(cursor), year: null });
    }
  }

  let updated = 0;
  for (const blk of parsed) {
    if (!blk.year) continue;
    const key = `${blk.year}${String(blk.month).padStart(2, '0')}`;
    const info = anchors.get(key);
    const set = info ? info.days : new Set();
    const mm = String(blk.month).padStart(2, '0');

    // 先把导航页里原本手工加的链接记下来，默认保留
    const existing = new Map();
    const tbl = blk.raw.match(/<table>[\s\S]*?<\/table>/);
    if (tbl) {
      for (const m of tbl[0].matchAll(/<a href='([^']*)'>(\d+)日<\/a>/g)) {
        existing.set(String(+m[2]).padStart(2, '0'), m[1]);
      }
    }

    const table = calendarTable(blk.year, blk.month, (d) => {
      const dd = String(d).padStart(2, '0');
      if (set.has(dd)) return `<a href='/niki/niki_${key}/#${mm}${dd}'>${d}日</a>`;
      if (!prune && existing.has(dd)) return `<a href='${existing.get(dd)}'>${d}日</a>`;
      return `${d}日`;
    });
    const next = blk.raw.replace(/<table>[\s\S]*?<\/table>/, table);
    if (next !== blk.raw) updated++;
    blk.raw = next;
  }

  const present = new Set(parsed.filter((b) => b.year)
    .map((b) => `${b.year}${String(b.month).padStart(2, '0')}`));
  const missing = [...anchors.entries()]
    .filter(([k]) => !present.has(k))
    .sort((a, b) => (b[1].year * 100 + b[1].month) - (a[1].year * 100 + a[1].month));

  const addedNames = [];
  for (const [key, info] of missing) {
    const block = navigatorBlock(info.year, info.month, info.days);
    let idx = parsed.findIndex((b) => b.year && (b.year * 100 + b.month) < (info.year * 100 + info.month));
    if (idx < 0) idx = parsed.length;
    parsed.splice(idx, 0, { raw: block, year: info.year, month: info.month });
    addedNames.push(`${info.year}年${info.month}月`);
  }

  if (updated || missing.length) {
    const out = fmText + intro + '\n<hr>\n' + parsed.map((b) => b.raw).join('\n<hr>\n');

    // 保险：出现重复月份就说明切分出错了，宁可不写也不弄坏文件
    const count = new Map();
    for (const m of out.matchAll(/<center>\s*(\d{4})年\s*(\d{1,2})月\s*<\/center>/g)) {
      const k = `${m[1]}年${+m[2]}月`;
      count.set(k, (count.get(k) || 0) + 1);
    }
    const dup = [...count.entries()].filter(([, n]) => n > 1).map(([k]) => k);
    if (dup.length) {
      throw new Error('同步后会出现重复月份（' + dup.join('、') + '），已中止，没有写入文件');
    }
    await writeText('content/navigator.md', out);
  }
  return { updated, added: addedNames };
}

/* ============================================================
   请求处理
   ============================================================ */

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 48 * 1024 * 1024) throw new Error('内容太大了（上限 48MB）');
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

  /* ---------- ping：不需要令牌，用来识别「这个端口是不是我自己」---------- */
  if (p === '/api/ping') {
    return json(res, 200, { app: 'hoshi-editor', port: PORT, root: ROOT });
  }

  /* ---------- 简易 CSRF 防护 ---------- */
  if (req.headers['x-editor-token'] !== TOKEN) { json(res, 403, { error: '令牌不对' }); return; }

  /* ---------- 路由 ---------- */
  if (p === '/api/bootstrap' && req.method === 'GET') {
    const alive = await hugoAlive();
    let liveUrl = '';
    try {
      const cfg = await readText('hugo.toml');
      const m = cfg.match(/^\s*baseURL\s*=\s*"([^"]*)"/m);
      if (m) liveUrl = m[1];
    } catch { /* 读不到就算了 */ }
    let gitStatus = [], gitLog = [];
    const s = await git(['status', '--porcelain']);
    gitStatus = s.stdout.split('\n').map((x) => x.trimEnd()).filter(Boolean);
    const l = await git(['log', '-8', '--pretty=format:%h\t%ad\t%s', '--date=format:%m-%d']);
    gitLog = l.stdout.split('\n').filter(Boolean);
    return json(res, 200, {
      root: ROOT,
      hugo: HUGO,
      previewUrl: hugoUrl,
      liveUrl,
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
    const { kind, name, title, date, asDraft, headImage } = await readBody(req);
    const clean = String(name || '').trim().replace(/[\\/:*?"<>|]/g, '');
    if (!clean) throw new Error('文件名不能为空');
    const d = date || new Date().toISOString().slice(0, 10);
    const draftFlag = asDraft === false ? 'false' : 'true';

    let rel, body;
    if (kind === 'blog') {
      rel = `content/blog/${clean}.md`;
      body = `---\ntitle: "${title}"\ndate: ${d}\ndraft: ${draftFlag}\ntags: []\ndescription: ""\n---\n\n在这里写正文。\n\n<!--more-->\n`;
    } else if (kind === 'niki') {
      // 年月优先从文件名 niki_YYYYMM 里取，取不到就用日期
      let y, mo;
      const mm = clean.match(/(\d{4})\D?(\d{2})/);
      if (mm) { y = +mm[1]; mo = +mm[2]; }
      else { y = +d.slice(0, 4); mo = +d.slice(5, 7); }
      if (!(mo >= 1 && mo <= 12)) throw new Error('从文件名或日期里读不出月份: ' + clean);
      rel = `content/niki/${clean}.md`;
      const tmpl = diaryTemplate(y, mo, { headImage: headImage || '' });
      body = `---\ntitle: "${title}"\ndate: ${y}-${String(mo).padStart(2, '0')}-01\ndraft: ${draftFlag}\ndescription: ""\n---\n\n${tmpl}`;
    } else {
      rel = `content/${clean}.md`;
      body = `---\ntitle: "${title}"\ndraft: ${draftFlag}\ndescription: ""\n---\n\n在这里写内容。\n`;
    }
    if (await fsp.stat(safePath(rel)).catch(() => null)) throw new Error('文件已存在: ' + rel);
    await writeText(rel, body);

    let navSync = null;
    // 导航页的日历现在是构建时生成的（短代码 niki-cal-all 会遍历所有日记页），
    // 所以新建日记不需要再往 navigator.md 里插任何东西。
    // 这里保留这个字段只为兼容前端的提示逻辑。
    if (kind === 'niki') navSync = { updated: 0, added: [], auto: true };

    return json(res, 200, { ok: true, p: rel, navSync });
  }

  /* ---------- 图片上传（拖拽 / 选择）---------- */
  if (p === '/api/upload' && req.method === 'POST') {
    const { name, data } = await readBody(req);
    if (!data) throw new Error('没有收到图片数据');
    const buf = Buffer.from(String(data).replace(/^data:[^;]+;base64,/, ''), 'base64');
    if (!buf.length) throw new Error('图片是空的');

    let clean = String(name || 'image').replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, '-');
    if (!/\.[a-z0-9]+$/i.test(clean)) clean += '.png';
    const dir = 'static/images';
    await fsp.mkdir(safePath(dir), { recursive: true });

    // 重名就加序号
    const dot = clean.lastIndexOf('.');
    const stem = clean.slice(0, dot), ext = clean.slice(dot);
    let final = clean, n = 1;
    while (await fsp.stat(safePath(`${dir}/${final}`)).catch(() => null)) {
      final = `${stem}-${n++}${ext}`;
    }
    await fsp.writeFile(safePath(`${dir}/${final}`), buf);
    return json(res, 200, { ok: true, url: '/images/' + final, rel: `${dir}/${final}`, bytes: buf.length });
  }

  /* ---------- 草稿开关 ---------- */
  if (p === '/api/draft' && req.method === 'POST') {
    const { p: rel, draft } = await readBody(req);
    let text = await readText(rel);
    const val = draft ? 'true' : 'false';
    if (/^draft:\s*(true|false)/m.test(text)) {
      text = text.replace(/^(draft:\s*)(true|false)/m, `$1${val}`);
    } else {
      text = text.replace(/^---\r?\n/, `---\ndraft: ${val}\n`);
    }
    await writeText(rel, text);
    return json(res, 200, { ok: true, draft: !!draft });
  }

  /* ---------- 导航页 ---------- */
  if (p === '/api/nav' && req.method === 'GET') {
    const anchors = await collectDiaryAnchors();
    const nav = await readText('content/navigator.md');
    // 导航页正文里已经不再写月份标题了（日历由 niki-cal-all 短代码生成），
    // 所以「导航页上有没有这个月」直接以日记页为准：有日记页就一定有。
    const hasAll = /niki-cal-all/.test(nav);
    const months = [...anchors.values()].map((v) => `${v.year}年${v.month}月`);
    return json(res, 200, {
      auto: hasAll,
      diaries: [...anchors.entries()].map(([k, v]) => ({
        key: k, year: v.year, month: v.month, days: [...v.days].sort(),
      })).sort((a, b) => (b.year * 100 + b.month) - (a.year * 100 + a.month)),
      navMonths: months,
    });
  }

  if (p === '/api/nav/sync' && req.method === 'POST') {
    // 这个接口以前负责把日历写进 content/navigator.md。
    // 2026-09-12 起改成构建时由短代码生成，再写一遍反而会多出一份表格，
    // 所以这里直接不干活，只回一句说明。
    return json(res, 200, {
      updated: 0, added: [], auto: true,
      message: '导航页的日历现在由短代码自动生成，不需要手动同步了。',
    });
  }

  /* ---------- 侧栏排序 ---------- */
  if (p === '/api/order' && req.method === 'GET') {
    return json(res, 200, await readOrder());
  }
  if (p === '/api/order' && req.method === 'POST') {
    const { group, files } = await readBody(req);
    if (!group || !Array.isArray(files)) throw new Error('参数不对：需要 group 和 files');
    const order = await readOrder();
    order[String(group)] = files.map(String);
    ORDER_CACHE = order;
    await writeText(ORDER_FILE, JSON.stringify(order, null, 2) + '\n');
    return json(res, 200, { ok: true, group, count: files.length });
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
    const spec = DATA_LISTS[which];
    if (!spec) return json(res, 404, { error: '没有这个列表：' + which });
    if (req.method === 'GET') return json(res, 200, { items: parseItems(await readText(spec.file)), keys: spec.keys });

    let { items } = await readBody(req);
    if (!Array.isArray(items)) throw new Error('参数不对：需要 items 数组');

    if (which === 'updates' || which === 'notices') {
      // 这两个列表都是「日期 + 一句话 + 可选链接」，规则一样，只是正文的字段名不同
      const textKey = which === 'updates' ? 'title' : 'text';
      // 空行（点了「加一条」还没填的）直接丢掉，免得往 toml 里写一堆空 [[items]]
      items = items.filter((it) => String(it.date || '').trim() || String(it[textKey] || '').trim());
      const today = new Date().toISOString().slice(0, 10);
      for (const it of items) {
        // 日期写坏的话 Hugo 构建会直接报错（模板里要 time 解析它），所以这里先拦住
        let d = String(it.date || '').trim().slice(0, 10);
        if (!d) d = today;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error(`日期要写成 YYYY-MM-DD：「${it.date}」`);
        it.date = d;
        it[textKey] = String(it[textKey] || '').trim() || (which === 'updates' ? '（没写标题）' : '（没写内容）');
      }
    }

    await writeText(spec.file, writeItems(spec.header, items, spec.keys));
    return json(res, 200, { ok: true, count: items.length });
  }

  /* ---------- 侧栏挂件顺序 ---------- */
  if (p === '/api/sidebar' && req.method === 'GET') {
    const saved = parseSidebarOrder(await readText('data/sidebar.toml')).filter(
      (k) => SIDEBAR_WIDGETS.some((w) => w[0] === k));
    // 文件里没列到的挂件补在最后，和 sidebar.html 的兜底逻辑保持一致
    const order = [...saved];
    for (const [key] of SIDEBAR_WIDGETS) if (!order.includes(key)) order.push(key);
    return json(res, 200, {
      order,
      saved,
      widgets: SIDEBAR_WIDGETS.map(([key, label]) => ({ key, label })),
    });
  }

  if (p === '/api/sidebar' && req.method === 'POST') {
    const { order } = await readBody(req);
    if (!Array.isArray(order)) throw new Error('参数不对：需要 order 数组');
    const unknown = order.filter((k) => !SIDEBAR_WIDGETS.some((w) => w[0] === k));
    if (unknown.length) throw new Error('不认识的挂件：' + unknown.join('、'));
    await writeText('data/sidebar.toml', writeSidebarOrder(order.map(String)));
    return json(res, 200, { ok: true, order: order.map(String) });
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
    if (action === 'status') {
      return json(res, 200, { running: await hugoAlive(), url: hugoUrl });
    }
    if (action === 'log') return json(res, 200, { log: hugoLog, url: hugoUrl });
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
    if (url.pathname.startsWith('/api/')) logAccess(`${req.method} ${url.pathname} -> ${res.statusCode}`);
  } catch (e) {
    logAccess(`${req.method} ${url.pathname} -> 500 ${e.message || e}`);
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
  console.log('   node:  ' + process.version + '  (' + process.platform + ')');
  console.log('   hugo:  ' + HUGO + (hugoOk ? '' : '   ← 没找到！'));
  if (!hugoOk) {
    console.log('');
    console.log('   编辑和保存不受影响，但预览 / 构建检查 / 发布会用不了。装一个：');
    if (IS_MAC) console.log('     brew install hugo          （要 extended 版）： brew install hugo');
    else if (IS_WIN) console.log('     winget install Hugo.Hugo.Extended');
    else console.log('     见 https://gohugo.io/installation/');
  }
  console.log('');
  console.log('   关掉这个窗口 = 停止编辑器。');
  console.log('');

  const r = await hugoStart();
  console.log('   预览服务器: ' + r.note + '  http://127.0.0.1:' + HUGO_PORT + '/');
  console.log('');

  openBrowser(`http://127.0.0.1:${PORT}/`);
});

server.on('error', async (e) => {
  if (e.code === 'EADDRINUSE') {
    const mine = await pingExisting();
    if (mine) {
      console.log('');
      console.log('  编辑器已经在运行了（端口 ' + PORT + '），把浏览器打开就行。');
      console.log('  地址: http://127.0.0.1:' + PORT + '/');
      console.log('');
      openBrowser(`http://127.0.0.1:${PORT}/`);
      await sleep(800);
      process.exit(0);
    }
    console.error('');
    console.error('  端口 ' + PORT + ' 被别的程序占用了。');
    console.error('  换个端口再跑：');
    if (IS_WIN) {
      console.error('    set EDITOR_PORT=4322 && node .editor\\server.mjs');
    } else {
      console.error('    EDITOR_PORT=4322 node .editor/server.mjs');
    }
    console.error('');
    process.exit(1);
  }
  console.error(e);
  process.exit(1);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => { await hugoStop(); process.exit(0); });
}
