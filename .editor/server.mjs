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
/* 本进程的启动时间。前端拿它和磁盘上 server.mjs 的修改时间比：
   如果文件比进程新，说明 pull 过新代码但没重启，跑的还是旧逻辑。 */
const STARTED_AT = Date.now();
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
      let errOut = stderr || '';
      if (err && err.killed) {
        const sec = opts.timeout ? Math.round(opts.timeout / 1000) : 0;
        errOut += (errOut ? '\n' : '') +
          `（命令超过 ${sec} 秒没反应，已经中断 —— 多半是网络不通或者要走代理）`;
      }
      resolve({
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        stdout: stdout || '',
        stderr: errOut,
      });
    });
  });
}

const git = (args) => run('git', args);

/* ---------- git 状态：本地改了什么、比线上多几个 / 少几个提交 ----------
   两台电脑轮流用编辑器时，最常见的情况是「另一台推过了、这一台还没拉」：
   这种时候推送会被 GitHub 拒掉（non-fast-forward），而工作区可能又是干净的 ——
   只看 `git status` 会误判成「没有需要发布的改动」。
   所以这里每次都 fetch 一下，把 ahead / behind 一起算出来，页面据此提示。 */
let fetchAt = 0, fetchOk = null;
async function gitFetch(force = false) {
  if (!force && Date.now() - fetchAt < 20000) return fetchOk;
  const r = await run('git', ['fetch', '--quiet', 'origin', 'main'], { timeout: 20000 });
  fetchAt = Date.now();
  fetchOk = r.code === 0;
  return fetchOk;
}

async function gitState(fetchFirst = true) {
  if (fetchFirst) await gitFetch();
  const [s, l, br, cnt] = await Promise.all([
    git(['status', '--porcelain']),
    git(['log', '-8', '--pretty=format:%h\t%ad\t%s', '--date=format:%m-%d']),
    git(['rev-parse', '--abbrev-ref', 'HEAD']),
    git(['rev-list', '--left-right', '--count', 'origin/main...HEAD']),
  ]);
  let behind = null, ahead = null;
  const m = /^(\d+)\s+(\d+)$/.exec(cnt.stdout.trim());
  if (m) { behind = parseInt(m[1], 10); ahead = parseInt(m[2], 10); }
  return {
    status: s.stdout.split('\n').map((x) => x.trimEnd()).filter(Boolean),
    log: l.stdout.split('\n').filter(Boolean),
    branch: br.stdout.trim(),
    ahead, behind, remoteOk: fetchOk,
  };
}

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
      // 跳过隐藏文件；下划线开头的也跳过，但 **section 首页 _index.md 除外** ——
      // 它是那一组的门面（文集的绿色主题就是靠它的 cascade 带下来的），
      // 不在编辑器里露出来的话，那一组会是空的、也改不了。
      const isSectionIndex = e.name === '_index.md';
      if (e.name.startsWith('.') || (e.name.startsWith('_') && !isSectionIndex)) continue;
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

  /* 「首页与单页」这些：先按固定顺序排（_index 在最前，符合直觉），
     再自动补上 content/ 顶层里其它还没列到的 .md。
     以前这里是写死的名单 —— 我新加了 content/updates.md 却忘了登记，
     结果站长在编辑器里看不到那个页面、改不了文案。自动发现就不会再漏。
     注意：只认**顶层**文件（不递归），博客/日记在各自的组里。 */
  const staticsOrder = [
    'content/_index.md', 'content/self_intros.md', 'content/navigator.md',
    'content/gallery.md', 'content/updates.md', 'content/tobitaiaaken.md', 'content/ihsobijin2006.md',
  ];
  let topFiles = [];
  try {
    for (const e of await fsp.readdir(safePath('content'), { withFileTypes: true })) {
      if (e.isFile() && isMd(e.name)) topFiles.push('content/' + e.name);
    }
  } catch { /* content/ 读不到就算了，下面还会用固定名单兜底 */ }
  const statics = [...new Set([...staticsOrder, ...topFiles])].sort((a, b) => {
    const ia = staticsOrder.indexOf(a), ib = staticsOrder.indexOf(b);
    if (ia >= 0 && ib >= 0) return ia - ib;      // 名单内的按名单顺序
    if (ia >= 0) return -1;                      // 名单内的排前面
    if (ib >= 0) return 1;
    return a.localeCompare(b);                   // 其余按名字
  });
  tree.push({
    group: '首页与单页', kind: 'content',
    files: (await Promise.all(statics.map(async (f) =>
      (await fsp.stat(safePath(f)).catch(() => null)) ? f : null))).filter(Boolean),
  });

  const blog = (await listDir('content/blog')).filter(isMd).sort();
  tree.push({ group: '博客', kind: 'content', files: blog });

  // 文集（绿色主题那个 section）：_index.md 排最前，然后是各篇
  const col = (await listDir('content/collection')).filter(isMd)
    .sort((a, b) => (a.endsWith('/_index.md') ? -1 : b.endsWith('/_index.md') ? 1 : a.localeCompare(b)));
  tree.push({ group: '文集', kind: 'content', files: col });

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
   顶部导航栏 —— hugo.toml 里的 [[menu.main]]
   每个块长这样（编辑器「站点设置」只管 [params]，所以这些标签一直没地方改）：
       [[menu.main]]
         name    = "画廊"
         pageRef = "/gallery/"
         weight  = 50
   ============================================================ */

function parseMenu(text) {
  const lines = text.split(/\r?\n/);
  const items = [];
  let cur = null;
  for (const line of lines) {
    if (/^\s*\[\[menu\.main\]\]\s*$/.test(line)) { cur = { name: '', pageRef: '', url: '' }; items.push(cur); continue; }
    if (/^\s*\[/.test(line)) { cur = null; continue; }      // 进到别的段就停
    if (!cur) continue;
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*"(.*)"\s*$/);
    if (m) cur[m[1]] = m[2].replace(/\\"/g, '"');
  }
  return items;
}

/* 写回菜单：整段重排（weight 按顺序重编 10/20/30…）。
   菜单块在 hugo.toml 里的位置保持不变，只换内容。 */
function writeMenu(text, items) {
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const first = lines.findIndex((l) => /^\s*\[\[menu\.main\]\]\s*$/.test(l));
  if (first < 0) throw new Error('hugo.toml 里找不到 [[menu.main]] 段');
  let last = first;
  for (let i = first; i < lines.length; i++) {
    if (/^\s*\[\[menu\.main\]\]\s*$/.test(lines[i])) { last = i; continue; }
    // 菜单块之间允许有空行和注释；碰到别的段就停
    if (i > first && /^\s*\[/.test(lines[i])) break;
  }
  const blocks = [];
  items.forEach((it, i) => {
    if (!String(it.name || '').trim()) return;
    blocks.push('[[menu.main]]');
    blocks.push(`  name    = "${String(it.name).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
    const ref = String(it.pageRef || it.url || '').trim();
    if (ref) blocks.push(`  pageRef = "${ref.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
    blocks.push(`  weight  = ${(i + 1) * 10}`);
    blocks.push('');
  });
  while (blocks.length && blocks[blocks.length - 1] === '') blocks.pop();
  const out = [...lines.slice(0, first), ...blocks, ...lines.slice(last + 1)];
  return out.join(nl);
}

/* ============================================================
   data/*.toml 的 [[items]] 列表
   ============================================================ */

function parseItems(text) {
  const items = [];
  let cur = null;
  let inSection = false;
  let arr = null;                 // 正在读的字符串数组
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    // 大多数列表用 [[items]]；音乐那份用语义更清楚的 [[tracks]]，文集的分册用 [[books]]
    if (t === '[[items]]' || t === '[[tracks]]' || t === '[[books]]') { cur = {}; items.push(cur); inSection = true; arr = null; continue; }
    if (!inSection) continue;

    // 数组续行：一句一行，到 ] 结束（更新日志里「同一日期多条」就是这种）
    if (arr) {
      const end = t.match(/^\]\s*,?\s*$/);
      if (end) { arr = null; continue; }
      const v = t.match(/^"(.*)"\s*,?\s*$/);
      if (v) { cur[arr].push(v[1].replace(/\\"/g, '"')); continue; }
      // 看不懂的行就结束数组，别把后面整段吃掉
      arr = null;
    }

    // 空行结束当前段落：后面的顶层设置（比如音乐那份结尾的 assetDir / title）
    // 不能再算进最后一条，否则会把曲目的 title 覆盖掉。
    if (!t) { cur = null; continue; }
    if (t.startsWith('#')) continue;
    if (!cur) continue;

    // text = [ 开头
    const open = t.match(/^([A-Za-z0-9_]+)\s*=\s*\[\s*$/);
    if (open) {
      cur[open[1]] = [];
      arr = open[1];
      continue;
    }
    const m = t.match(/^([A-Za-z0-9_]+)\s*=\s*"(.*)"\s*$/);
    if (m) { cur[m[1]] = m[2].replace(/\\"/g, '"'); continue; }
    // 布尔值（更新日志里标「子条目」用的 indent = true）
    const b = t.match(/^([A-Za-z0-9_]+)\s*=\s*(true|false)\s*$/);
    if (b) { cur[b[1]] = b[2] === 'true'; continue; }
    // 不带引号的数字（文集分册的 order = 10）。放在最后，免得抢走别的写法。
    const num = t.match(/^([A-Za-z0-9_]+)\s*=\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (num) cur[num[1]] = Number(num[2]);
  }
  return items;
}

/* 写一条：值可以是字符串，也可以是字符串数组（一句一行）。
   更新日志里「同一日期下好几条」用的就是数组。
   空值默认不写 —— 少一堆 `url = ""` / `title = ""` 这种噪音，也让
   「读出来 -> 原样写回」的往返完全一致（有测试盯着这一点）。
   只有 date 例外：它是必填，空着也要留个位置，免得整段少一个字段。 */
const KEEP_EMPTY_KEYS = new Set(['date']);

function writeItems(header, items, keys, section = 'items') {
  const out = [header.trimEnd(), ''];
  for (const it of items) {
    out.push(`[[${section}]]`);
    for (const k of keys) {
      const raw = it[k];
      if (typeof raw === 'boolean') {
        // 布尔字段照实写（更新日志的 indent = true）；false 不写
        if (raw) out.push(`  ${k} = true`);
        continue;
      }
      if (Array.isArray(raw)) {
        const vals = raw.map((x) => String(x ?? '').trim()).filter(Boolean);
        if (!vals.length) continue;                  // 空数组不写
        out.push(`  ${k} = [`);
        for (const v of vals) out.push(`    "${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}",`);
        out.push('  ]');
      } else {
        const s = String(raw ?? '');
        if (!s.trim() && !KEEP_EMPTY_KEYS.has(k)) continue;
        out.push(`  ${k} = "${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
      }
    }
    out.push('');
  }
  return out.join('\n');
}

/* ============================================================
   文集：分册表 + 文章的归属
   ------------------------------------------------------------
   分册表在 data/collection_books.toml（段落名 [[books]]），
   文章的归属写在各自的 front matter 里：
     book  = "ktt"        属于哪一册
     weight = 10          册内章节顺序（不写就按日期）
     essay = true         随感（不进册，目录页单独一组）
     r18   = true         单篇标红（整册标红在分册表里）
     collection_tags = ["…"]   文集标签（独立 taxonomy）
   ============================================================ */

const COLLECTION_BOOKS_FILE = 'data/collection_books.toml';

const COLLECTION_BOOKS_HEADER = `# ============================================================
#  文集的分册表 —— /collection/ 按 order 一册渲染成一个框
#
#  这份文件由编辑器左侧「文集」面板管理（手改也行，注释会自动保留）。
#  段落名必须是 [[books]]，编辑器认这个。
#
#  字段：
#    id     = "ktt"       必填 —— 唯一标识；文章的 front matter 里写 book = "ktt"
#    title  = "…"         必填 —— 书名（框的标题条）
#    status = "连载中"    选填 —— 连载中 / 已完结 / 停止更新（做成徽标）
#    r18    = true        选填 —— 整册标红，并在目录页顶部出一条提示
#    order  = 10          选填 —— 框的先后，小的在前（写数字，不要加引号）
#    desc   = "…"         选填 —— 一句话简介，显示在书名下面
#
#  一册里还没有章节时，目录页会跳过它（不显示空框）。
# ============================================================`;

const BOOK_KEYS = ['id', 'title', 'status', 'r18', 'order', 'desc'];

async function readCollectionBooks() {
  let raw = '';
  try { raw = await readText(COLLECTION_BOOKS_FILE); } catch { raw = ''; }
  return parseItems(raw);
}

/** 分册表写盘：order 要写成不带引号的数字，Hugo 那边才能按数值排序 */
async function writeCollectionBooks(books) {
  const clean = books.map((b) => ({
    id: String(b.id ?? '').trim(),
    title: String(b.title ?? '').trim(),
    status: String(b.status ?? '').trim(),
    r18: b.r18 === true,
    order: String(b.order ?? '').trim(),
    desc: String(b.desc ?? '').trim(),
  })).filter((b) => b.id || b.title);

  for (const b of clean) {
    if (!b.id) throw new Error(`「${b.title || '没写书名的那一册'}」还没有 id`);
    if (!b.title) throw new Error(`id 为 ${b.id} 的那一册还没有书名`);
    if (!/^[A-Za-z0-9_-]+$/.test(b.id)) throw new Error(`id 只能用字母、数字、下划线、短横线：${b.id}`);
  }
  const dup = clean.map((b) => b.id).find((x, i, arr) => arr.indexOf(x) !== i);
  if (dup) throw new Error(`id 重复了：${dup}`);

  const out = [COLLECTION_BOOKS_HEADER.trimEnd(), ''];
  for (const b of clean) {
    out.push('[[books]]');
    out.push(`  id = "${b.id}"`);
    out.push(`  title = "${b.title.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
    if (b.status) out.push(`  status = "${b.status.replace(/"/g, '\\"')}"`);
    if (b.r18) out.push('  r18 = true');
    out.push(`  order = ${Number.isFinite(Number(b.order)) && b.order !== '' ? Math.trunc(Number(b.order)) : 0}`);
    if (b.desc) out.push(`  desc = "${b.desc.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
    out.push('');
  }
  await writeText(COLLECTION_BOOKS_FILE, out.join('\n'));
  return clean;
}

/** 读一篇文章的 front matter（只认简单的 `key: value`，够文集用） */
function parseFrontMatter(text) {
  const m = String(text).replace(/^\uFEFF/, '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    if (/^".*"$/.test(v) || /^'.*'$/.test(v)) v = v.slice(1, -1);
    else if (v === 'true') v = true;
    else if (v === 'false') v = false;
    // 不带引号的数字（weight: 2）当成数字，否则写回去会变成 "2" —— Hugo 的 weight 要数字
    else if (/^-?\d+$/.test(v)) v = parseInt(v, 10);
    else if (/^-?\d*\.\d+$/.test(v)) v = parseFloat(v);
    else if (/^\[.*\]$/.test(v)) {
      v = v.slice(1, -1).split(',').map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    }
    fm[kv[1]] = v;
  }
  return fm;
}

function serializeFrontValue(v) {
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  if (Array.isArray(v)) {
    return '[' + v.map((x) => '"' + String(x).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"').join(', ') + ']';
  }
  return '"' + String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/** 只动 front matter：值为 null / 空串 / 空数组 就把那一行删掉，其余就地替换或补在末尾 */
function setFrontMatter(text, updates) {
  const m = String(text).replace(/^\uFEFF/, '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) throw new Error('这个文件没有 front matter（开头应当是 ---）');
  const blank = (v) => v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length);
  const kept = [];
  const seen = new Set();
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*:/);
    if (kv && Object.prototype.hasOwnProperty.call(updates, kv[1])) {
      seen.add(kv[1]);
      if (blank(updates[kv[1]])) continue;      // 清空 = 删掉这一行，别留 book: "" 这种噪音
      kept.push(`${kv[1]}: ${serializeFrontValue(updates[kv[1]])}`);
      continue;
    }
    kept.push(line);
  }
  for (const k of Object.keys(updates)) {
    if (!seen.has(k) && !blank(updates[k])) kept.push(`${k}: ${serializeFrontValue(updates[k])}`);
  }
  const start = String(text).replace(/^\uFEFF/, '');
  const rest = start.slice(start.match(/^---\r?\n([\s\S]*?)\r?\n---/)[0].length);
  return `---\n${kept.join('\n')}\n---${rest}`;
}

/* ------------------------------------------------------------
   把「漏在正文开头的 front matter 字段」收回 front matter
   ------------------------------------------------------------
   手改的时候很容易把那几行打在结束的 --- **下面**，那样它们就成了正文，
   页面上会原样显示成 `collection_tags: [...]` 这种。这里做两件事：
     1. 认开头连续的那几行（只认文集管的键，认到不认识的非空行就停）
     2. 把它们解析成值返回，并从正文里删掉 —— 由调用方并进 front matter
   只动「正文最开头」这一小段，后面的正文一个字不碰。
   ------------------------------------------------------------ */
const COLLECTION_PARAM_KEYS = ['book', 'weight', 'essay', 'r18', 'collection_tags'];

function hoistLeakedCollectionParams(text) {
  const src = String(text).replace(/^\uFEFF/, '');
  const m = src.match(/^(---\r?\n[\s\S]*?\r?\n---)([\s\S]*)$/);
  if (!m) return { text: src, moved: {} };
  const lines = m[2].split(/\r?\n/);
  const grabbed = [];
  const drop = new Set();
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) continue;                       // 空行跳过，继续往后找
    const kv = t.match(/^([A-Za-z0-9_-]+)\s*:\s*(.+)$/);
    if (!kv || !COLLECTION_PARAM_KEYS.includes(kv[1])) break;
    grabbed.push(`${kv[1]}: ${kv[2].trim()}`);
    drop.add(i);
  }
  if (!grabbed.length) return { text: src, moved: {} };
  const moved = parseFrontMatter(`---\n${grabbed.join('\n')}\n---`);
  const kept = lines.filter((_, i) => !drop.has(i));
  return { text: m[1] + kept.join('\n'), moved, dropped: [...drop].length };
}

/** 文集里的所有文章（不含 _index.md），带上归属信息给面板用 */
async function listCollectionArticles() {
  const files = (await listDir('content/collection')).filter(isMd).filter((f) => !/_index\.md$/.test(f));
  const out = [];
  for (const rel of files) {
    let fm = {};
    try { fm = parseFrontMatter(await readText(rel)); } catch { /* 读不了就只报个文件名 */ }
    const tags = Array.isArray(fm.collection_tags)
      ? fm.collection_tags
      : (fm.collection_tags ? [String(fm.collection_tags)] : []);
    out.push({
      file: rel,
      title: String(fm.title || rel.split('/').pop().replace(/\.md$/, '')),
      book: fm.book ? String(fm.book) : '',
      essay: fm.essay === true,
      r18: fm.r18 === true,
      draft: fm.draft === true,
      weight: fm.weight === undefined || fm.weight === null ? '' : String(fm.weight),
      date: String(fm.date || ''),
      tags,
    });
  }
  // 面板里按日期倒序，新建的稿子在最上面
  out.sort((a, b) => (a.date === b.date ? String(a.title).localeCompare(String(b.title)) : (a.date < b.date ? 1 : -1)));
  return out;
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

/* ⚠️ 这段必须和 data/changelog.toml 文件里那段**逐字一致**：
   编辑器保存时整段重写这个抬头，写短了就等于把文件里的说明「降级」掉
   （我犯过一次：保存后两种写法的例子没了）。改这里要同步改数据文件。

   ⚠️ 抬头里**一个字面量的段落头都不要写**（连注释里也不行）——
   Hugo 的 TOML 解析器会把注释里出现的段落头当成真的表格定义，
   然后撞上后面的中文报 "expected newline but got U+00EF"。
   下面用「段落头」三个字代替，只描述写法。 */
const CHANGELOG_HEADER = `# ============================================================
#  更新日志（完整记录）—— /updates/ 那一页读取这个文件
#
#  ⚠️ 和 data/updates.toml 不是一回事：
#      这里 = 网站结构更新（建站、换字体、接留言板…），完整历史
#      那边 = 「更新通报」，只进侧栏那块自动日志
#    首页「欢迎光临」显示这里最近 5 条，更多在 /updates/。
#
#    date   = "2026-09-22"        必填
#    title  = "连接了花涧堂。"       一条更新
#    url    = "/blog/xxx/"        可空，填了就变成链接
#
#  【同一天有更新时的两种写法 —— 按它们是不是「并行的大更新」来选】
#
#    并列（默认，大多数情况）：同一天写两段，date 都填同一天
#      date = "2026-02-05"   title = "创建了这个网站，添加了基本内容。"
#      date = "2026-02-05"   title = "增加了制作游戏常用素材分享页面。"
#      -> 两行平级显示，各自是一条更新（日期只出现在第一行）
#
#    折叠（同一件事分了几步、第二条算子更新）：后一段加 indent = true
#      date = "2026-09-28"                     title = "换了新的点阵字体"
#      date = "2026-09-28"  indent = true      title = "顺手把字号统一了"
#      -> 第一行正常，第二条缩进成子条目
#
#  每段都要以一对中括号加 items 开头（编辑器保存时会自动写好）。
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
  ['music',    '音乐播放器'],
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
#    music      音乐播放器（曲目在 data/music.toml，音频放 static/music/）
#
#  没列到的挂件会自动补在最后，所以新加的挂件不会凭空消失。
# ============================================================`;

function parseSidebarOrder(text) {
  const m = text.match(/^\s*order\s*=\s*\[([^\]]*)\]/m);
  if (!m) return [];
  return m[1].split(',').map((s) => s.trim().replace(/^"|"$/g, '')).filter(Boolean);
}

/* 音乐播放器那份 data/music.toml 的抬头注释。
   注意段落名是 [[tracks]]（不是 [[items]]），编辑器按这个认曲目。 */
const MUSIC_HEADER = `# ============================================================
#  音乐播放器 —— 侧栏最上面那条窄条挂件
#
#  这份文件由编辑器左侧的「音乐」面板管理（音频也能直接上传进去），
#  手改也行。曲目段落名必须是 [[tracks]]，编辑器认这个。
#
#  字段：
#    file   = "iforest.mp3"   必填 —— static/music/ 里的文件名（不带目录），
#                              或者完整的 https:// 外链
#    title  = "iforest"       选填 —— 显示的名字；不写就用文件名
#    artist = "来源未知"       选填 —— 作者 / 出处
#
#  一首都没填时，侧栏那条播放器整个不显示。
# ============================================================`;

function writeSidebarOrder(order) {
  const keys = order.filter((k) => SIDEBAR_WIDGETS.some((w) => w[0] === k));
  return SIDEBAR_HEADER + '\norder = [' + keys.map((k) => `"${k}"`).join(', ') + ']\n';
}

/* ============================================================
   宝可梦放养区的台词（data/pkmn-talk/<图鉴号>.toml）
   ------------------------------------------------------------
   文件形状很固定：一行注释 + name = "..." + 若干「字符串数组」段，
   最后是 [page] / [weather] 两张表。编辑器只认这一种形状，保存时按同样的
   形状重写（首行注释保留，其余规范化）。数组里的空串会被丢掉。

   ⚠️ 改完这些 TOML 还不会生效 —— 页面读的是 tools/build-pkmn.py 生成的
   static/pkmn/talk/<图鉴号>.json，所以保存时会顺手跑一次
   `python tools/build-pkmn.py --talk`（不联网，一秒左右）。
   ============================================================ */
const PKMN_DIR = 'data/pkmn-talk';
// [键, 面板上显示的名字, 至少留几句（0 = 可以空着）]
const PKMN_POOLS = [
  ['pet', '被摸时说的', 6],
  ['pet_more', '连着摸太多次', 0],
  ['idle', '平常自己嘟囔', 9],
  ['night', '深夜（22:00–06:00）醒着时', 0],
  ['sleepy', '打瞌睡前说的', 2],
  ['sleep', '睡着时的梦话', 2],
  ['wake', '被戳醒时说的', 2],
];
const PKMN_PAGE = [
  ['home', '首页', 3], ['about', '关于站长', 3], ['blog', '博客文章', 3],
  ['diary', '日记本', 3], ['nav', '导航页', 3], ['gallery', '画廊', 0],
  ['tbtak', '始祖小鸟页', 0], ['other', '其它页面', 0],
];
const PKMN_WEATHER = [
  ['clear', '晴', 2], ['cloudy', '阴', 2], ['drizzle', '小雨', 0], ['rain', '雨', 2],
  ['snow', '雪', 2], ['thunder', '雷雨', 2], ['fog', '雾', 0],
];
const PKMN_POOL_KEYS = ['pools', 'page', 'weather'];

/* ============================================================
   始祖小鸟页放养区的台词（data/tbtak-talk/<id>.toml）
   ------------------------------------------------------------
   和侧栏那套是两份独立数据：这份没有 [page] / [weather] 两张表，
   只有 name + 五个字符串数组。生成物是 static/tbtak/talk/<id>.json，
   由 `python tools/build-tbtak.py --talk` 生成 —— 这条路径**不需要游戏工程**，
   只有拼素材（不带 --talk）才需要。

   至少几句要和 tools/build-tbtak.py 里的 TALK_REQ / TALK_OPT 对齐，
   不然面板上会看着「没问题」、生成脚本却报错。
   ============================================================ */
const TBTAK_DIR = 'data/tbtak-talk';
const TBTAK_POOLS = [
  ['greet', '刚出现时打招呼', 2],
  ['pet', '被摸时说的', 5],
  ['pet_more', '连着摸太多次', 2],   // 可空；写了就至少要 2 句
  ['idle', '平常自己嘟囔', 8],
  ['night', '深夜说的', 2],          // 可空；写了就至少要 2 句
];
// 可空的池子（面板上标「可空」，生成脚本只在「写了但不够」时报错）
const TBTAK_OPTIONAL = new Set(['pet_more', 'night']);

function parseTbtakTalk(text) {
  const res = { header: '', name: '', pools: {} };
  const head = [];
  let started = false;
  let cur = null;
  let buf = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const t = raw.trim();
    if (!started) {                              // 文件开头的注释原样留住
      if (!t || t.startsWith('#')) { head.push(raw); continue; }
      started = true;
    }
    if (buf) {                                   // 正在读多行数组
      if (t.startsWith(']')) { res.pools[cur] = buf; buf = null; cur = null; continue; }
      buf = buf.concat(quotedStrings(t));
      continue;
    }
    if (!t || t.startsWith('#')) continue;
    const nm = t.match(/^name\s*=\s*"(.*)"\s*$/);
    if (nm) { res.name = nm[1].replace(/\\"/g, '"'); continue; }
    const open = t.match(/^([A-Za-z0-9_]+)\s*=\s*\[\s*$/);
    if (open) { cur = open[1]; buf = []; continue; }
    const one = t.match(/^([A-Za-z0-9_]+)\s*=\s*\[(.*)\]\s*$/);   // key = ["a", "b"]
    if (one) { res.pools[one[1]] = quotedStrings(one[2]); continue; }
  }
  res.header = head.join('\n').replace(/\s+$/, '');
  return res;
}

function writeTbtakTalk(id, data) {
  const q = (s) => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  const out = [];
  // 注释块紧贴 name（不插空行）—— 和仓库里现有文件的写法保持一致，
  // 这样「原样打开 → 保存」不会凭空多出一个空行、每次保存都留个没意义的 diff。
  if (data.header) out.push(data.header);
  out.push(`name = ${q(data.name)}`, '');
  for (const [k] of TBTAK_POOLS) {
    const arr = (data.pools[k] || [])
      .map((s) => String(s).replace(/[\r\n]+/g, ' ').trim())
      .filter(Boolean);
    if (!arr.length) continue;                   // 空池子不写出来，省得生成脚本误判
    out.push(`${k} = [`);
    for (const s of arr) out.push(`  ${q(s)},`);
    out.push(']', '');
  }
  return out.join('\n').replace(/\n+$/, '\n');
}


/** data/pkmn-pool.toml：[[items]] + dex/name/en/sleep */
function parsePkmnPoolList(text) {
  const out = [];
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t === '[[items]]') { cur = {}; out.push(cur); continue; }
    if (!cur) continue;
    const m = t.match(/^([A-Za-z0-9_]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|(\d+))/);
    if (!m) continue;
    cur[m[1]] = m[2] !== undefined ? m[2].replace(/\\"/g, '"') : Number(m[3]);
  }
  return out;
}

/** 抠出一行里所有的 "..." 字符串 */
function quotedStrings(s) {
  const out = [];
  const re = /"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(s))) out.push(m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\'));
  return out;
}

function parsePkmnTalk(text) {
  const res = { header: '', name: '', pools: {}, page: {}, weather: {},
                order: { pools: [], page: [], weather: [] } };
  let section = res.pools;
  let sectionName = 'pools';
  let curKey = null;
  let buf = null;
  const keep = (obj, key, list) => {
    obj[key] = list;
    if (!res.order[sectionName].includes(key)) res.order[sectionName].push(key);
  };
  for (const raw of text.split(/\r?\n/)) {
    const t = raw.trim();
    if (buf) {                                   // 正在读一个多行数组
      if (t.startsWith(']')) { keep(section, curKey, buf); buf = null; curKey = null; continue; }
      buf = buf.concat(quotedStrings(t));
      continue;
    }
    if (!t) continue;
    if (t.startsWith('#')) {                     // 只留开头那段注释
      if (!res.name && !Object.keys(res.pools).length) res.header += raw + '\n';
      continue;
    }
    const sec = t.match(/^\[(\w+)\]$/);
    if (sec) {
      sectionName = sec[1] === 'page' ? 'page' : (sec[1] === 'weather' ? 'weather' : 'pools');
      section = res[sectionName];
      continue;
    }
    const kv = t.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    const rest = kv[2].trim();
    if (key === 'name' && rest.startsWith('"')) { res.name = quotedStrings(rest)[0] || ''; continue; }
    if (!rest.startsWith('[')) continue;
    const oneLine = quotedStrings(rest);
    if (rest.includes(']') && rest.indexOf(']') > rest.indexOf('[')) { keep(section, key, oneLine); continue; }
    curKey = key;
    buf = oneLine;
  }
  return res;
}

function writePkmnTalk(dex, name, data) {
  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const L = [];
  L.push(String(data.header || '').trim() || `# ${dex} ${name}`);
  L.push(`name = "${esc(name)}"`);
  const arr = (key, list) => {
    const v = (list || []).map((s) => String(s).trim()).filter(Boolean);
    if (!v.length) { L.push(`${key} = []`); return; }
    L.push(`${key} = [`);
    for (const s of v) L.push(`  "${esc(s)}",`);
    L.push(']');
  };
  // 键的顺序照文件里原来的来 —— 这样用编辑器改一句，diff 里就只有那一句，
  // 不会整段搬家。文件里没出现过的键按定义顺序补在后面。
  const keysOf = (defs, section) => {
    const want = (data.order && Array.isArray(data.order[section])) ? data.order[section] : [];
    const out = want.filter((k) => defs.some(([d]) => d === k));
    for (const [k] of defs) if (!out.includes(k)) out.push(k);
    return out;
  };
  for (const k of keysOf(PKMN_POOLS, 'pools')) { L.push(''); arr(k, data.pools[k]); }
  L.push('');
  L.push('[page]');
  for (const k of keysOf(PKMN_PAGE, 'page')) arr(k, data.page[k]);
  L.push('');
  L.push('[weather]');
  for (const k of keysOf(PKMN_WEATHER, 'weather')) arr(k, data.weather[k]);
  return L.join('\n') + '\n';
}

/* python 在哪（Windows 上可能是 python，macOS 上通常是 python3） */
function findPython() {
  /* 生成脚本要 `tomllib`（Python 3.11 才有）。所以不能只看「有没有 python3」：
     macOS 上 /usr/bin/python3 长期是 3.9，而机器上另装了 3.12 时，
     PATH 里的 python3 仍可能指向 3.9 —— 那样脚本会以 ModuleNotFoundError 收场
     （台词存下来了，页面读的 JSON 却没更新，看着像「改了没反应」）。
     这里按版本号从高到低试，并且**优先挑能 import tomllib 的那个**。 */
  const guesses = IS_WIN
    ? ['python', 'py', 'python3', 'python3.12', 'python3.11']
    : ['python3.13', 'python3.12', 'python3.11', 'python3', 'python'];
  let fallback = '';
  for (const g of guesses) {
    try {
      execFileSync(g, ['--version'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch { continue; }
    if (!fallback) fallback = g;
    try {
      execFileSync(g, ['-c', 'import tomllib'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      return g;
    } catch { /* 版本太老，试下一个 */ }
  }
  return fallback || guesses[0];
}
const PYTHON = findPython();

/** 能不能跑我们的生成脚本（= 能 import tomllib）。面板上据此给提示。 */
let pythonOk = false;
let pythonNote = '';
try {
  execFileSync(PYTHON, ['--version'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    execFileSync(PYTHON, ['-c', 'import tomllib'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    pythonOk = true;
  } catch {
    let ver = '';
    try { ver = execFileSync(PYTHON, ['--version'], { encoding: 'utf8', windowsHide: true }).trim(); } catch { /* 拿不到就算了 */ }
    pythonNote = `本机的 ${PYTHON} 是 ${ver || '未知版本'}，缺 tomllib（生成脚本要 Python 3.11 以上）：`
      + '台词能存进 TOML，但页面真正读的 JSON 不会更新。装一个 3.11+ 再重启编辑器即可'
      + '（macOS 上 `brew install python@3.12`，装完重开编辑器它会自己挑到新的）。';
  }
} catch {
  pythonNote = `没找到 python（试过 ${PYTHON}）：台词能存进 TOML，但页面读的 JSON 不会更新。`
    + '装好 python 3.11+ 之后重启编辑器，再点一次保存即可。';
}

/* 图片缩略图：调用 tools/make-thumb.py（只需要 Pillow）。
   失败不抛错 —— 缩略图是优化，不该拦住上传本身；
   把原因记在返回值里，面板上能看见。 */
function runThumbScript(srcRel, dstRel) {
  const script = path.join(ROOT, 'tools', 'make-thumb.py');
  try {
    const r = execFileSync(PYTHON, [script, srcRel.replace(/\//g, path.sep), dstRel.replace(/\//g, path.sep), '520'],
      { encoding: 'utf8', cwd: ROOT, windowsHide: true, timeout: 60000 });
    return JSON.parse(String(r).trim());
  } catch (e) {
    const raw = String((e.stdout || e.stderr || e.message || '')).trim();
    let detail = raw;
    try { detail = JSON.parse(raw).error || raw; } catch { /* 原样 */ }
    return { ok: false, error: String(detail).slice(0, 300) };
  }
}

/* 缩略图统一放 static/images/gallery/thumbs/，文件名里的 / 换成 __。
   为什么不跟原图放一起：画廊可以直接引用站上任意已有图片，缩略图要是放在
   原图旁边，static/images/ 那 110 个文件里会被掺进一堆 .webp（而且以后每加
   一张画就多一个同名文件）。集中一处，找也好找、删也好删。
   rel 是相对 /images/ 的路径，例如 gallery/AngheSan.jpg -> gallery/thumbs/gallery__AngheSan.webp */
function thumbRelFor(rel) {
  const clean = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const name = clean.replace(/\.[^.]+$/, '').replace(/\//g, '__');
  return `static/images/gallery/thumbs/${name}.webp`;
}


const GALLERY_HEADER = `# ============================================================
#  画廊（Infinite Gallery）—— 画作清单
#
#  由编辑器左侧「画作」面板维护，手改也行。
#  页面 content/gallery.md 正文里只写一行 {{< gallery >}}，
#  分类小节和缩略图网格都由这个文件生成。
#
#  一张画：
#    title = "画的名字"         必填
#    file  = "xxx.png"          必填 —— 相对 /images/ 的路径。
#                               编辑器上传的会落在 gallery/ 下，写 "gallery/xxx.png"
#    cat   = "hoshihum"         必填 —— 属于哪个分类（用分类的 id）
#    date  = "2026-08-07"       选填 —— 创作日期，没有就留空
#    cover = true               选填 —— 这张当分类封面（排最前）
#
#  分类：id 是页面锚点，改了旧链接会失效；desc 是标题下面那行灰色说明。
#
#  缩略图在 static/images/gallery/thumbs/（由编辑器上传/点按时生成），
#  没有缩略图就用原图，不影响显示。
# ============================================================`;

// data/*.toml 里那几张 [[items]] 列表：接口 /api/list/<key> 用这张表
// （依赖下面那些 *_HEADER 常量：const 有暂时性死区，这一块必须排在它们之后）
const DATA_LISTS = {
  links:   { file: 'data/links.toml',   keys: ['name', 'url', 'desc'],               header: LINKS_HEADER },
  buttons: { file: 'data/buttons.toml', keys: ['line1', 'line2', 'url', 'bg', 'fg'], header: BUTTONS_HEADER },
  updates: { file: 'data/updates.toml', keys: ['date', 'title', 'text', 'url'],       header: UPDATES_HEADER, multi: true },
  // 更新日志（网站结构更新的完整记录）：首页「欢迎光临」显示最近几条，全部在 /updates/
  changelog: { file: 'data/changelog.toml', keys: ['date', 'title', 'url', 'indent'], header: CHANGELOG_HEADER, changelog: true },
  notices: { file: 'data/notices.toml', keys: ['date', 'text', 'url'],               header: NOTICES_HEADER },
  // 音乐这份的段落名是 [[tracks]] 而不是 [[items]]，所以要单独写盘（见下面的分支）
  music:   { file: 'data/music.toml',   keys: ['file', 'title', 'artist'],           header: MUSIC_HEADER, section: 'tracks', music: true },
  // 画廊：两份列表（分类 sections + 画作 items），走字符串直出，见 writeGalleryFile
  gallery: { file: 'data/gallery.toml', keys: ['title', 'file', 'cat', 'date', 'desc', 'cover'], header: GALLERY_HEADER, gallery: true },
};



/* ============================================================
   音乐播放器：音频上传 + 「文件在不在」检查
   ============================================================ */

const AUDIO_EXT = new Set(['.mp3', '.ogg', '.m4a', '.wav', '.flac', '.aac', '.opus', '.oga', '.weba']);

/** 曲目地址是不是外链（外链不做本地存在性检查） */
function isExternalFile(f) {
  return /^(https?:)?\/\//i.test(String(f || '').trim());
}

/** 曲目 file 字段 -> static/music/ 里的真实路径；不安全的名字返回 null */
function musicPathFor(file) {
  const clean = String(file || '').trim().replace(/\\/g, '/');
  if (!clean || clean.startsWith('/') || clean.includes('..')) return null;
  return path.join(ROOT, 'static', 'music', ...clean.split('/'));
}

/**
 * 逐首看音频在不在。
 * 返回 [{ file, exists, external }]，外加整份都没问题时 missing=[]。
 * 只是提醒，不拦保存 —— 先写曲名后拷文件也是正常顺序。
 */
async function musicFileStatus(items) {
  const out = [];
  for (const it of items) {
    const f = String(it.file || '').trim();
    if (!f) continue;
    if (isExternalFile(f)) { out.push({ file: f, exists: true, external: true }); continue; }
    const full = musicPathFor(f);
    let exists = false;
    if (full) { try { exists = (await fsp.stat(full)).isFile(); } catch { exists = false; } }
    out.push({ file: f, exists, external: false });
  }
  return out;
}

/** 音乐这份 toml 的写盘：assetDir / title 这类顶层设置写最前面，然后是曲目。
    设置必须排在第一个 [[tracks]] 之前 —— 排在后面的话，解析时会被并进
    最后一条曲目里（试过，会把那首的 title 覆盖成顶层的 title）。 */
function writeMusicFile(header, items, settings) {
  const out = [header.trimEnd(), ''];
  out.push(`assetDir = ${JSON.stringify(settings.assetDir || 'music/')}`);
  out.push(`title = ${JSON.stringify(settings.title || '音乐')}`);
  out.push('');
  for (const it of items) {
    out.push('[[tracks]]');
    for (const k of ['file', 'title', 'artist']) {
      const v = String(it[k] ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      out.push(`  ${k} = "${v}"`);
    }
    out.push('');
  }
  return out.join('\n');
}

async function readMusicFile() {
  const text = await readText(DATA_LISTS.music.file);
  // 只认「第一个 [[tracks]] 之前」的顶层设置。
  // 不能直接全文正则：曲目里也有 title 字段，会把它当成顶层 title 抓过来。
  const head = text.split(/^\s*\[\[tracks\]\]/m)[0];
  return {
    text,
    assetDir: (head.match(/^\s*assetDir\s*=\s*"([^"]*)"/m) || [])[1] ?? 'music/',
    title: (head.match(/^\s*title\s*=\s*"([^"]*)"/m) || [])[1] ?? '音乐',
  };
}

/* ============================================================
   画廊（data/gallery.toml）
   ------------------------------------------------------------
   这份文件有两段列表：[[sections]]（分类）和 [[items]]（画作）。
   都按「同类型相邻、用空行分隔」的规范形状写出来，
   和 data/music.toml 那边同一个思路（解析器也是按空行断段的）。
   ============================================================ */

/** 从现有文件里抠出分类（保序，编辑器一直整份重写，所以不用管注释） */
function parseGallerySections(text) {
  const out = [];
  let cur = null;
  let inSec = false;
  for (const line of String(text).split(/\r?\n/)) {
    const t = line.trim();
    if (t === '[[sections]]') { cur = {}; out.push(cur); inSec = true; continue; }
    if (t === '[[items]]') { cur = null; inSec = false; continue; }
    if (!inSec) continue;
    if (!t) { cur = null; continue; }
    if (t.startsWith('#')) continue;
    if (!cur) continue;
    const m = t.match(/^([A-Za-z0-9_]+)\s*=\s*"(.*)"\s*$/);
    if (m) cur[m[1]] = m[2].replace(/\\"/g, '"');
  }
  return out;
}

const tomlStr = (v) => String(v ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');

function writeGalleryFile(header, sections, items) {
  const out = [header.trimEnd(), ''];
  for (const s of sections) {
    out.push('[[sections]]');
    out.push(`  id = "${tomlStr(s.id)}"`);
    out.push(`  name = "${tomlStr(s.name)}"`);
    out.push(`  desc = "${tomlStr(s.desc)}"`);
    out.push('');
  }
  for (const it of items) {
    out.push('[[items]]');
    out.push(`  title = "${tomlStr(it.title)}"`);
    out.push(`  file = "${tomlStr(it.file)}"`);
    out.push(`  cat = "${tomlStr(it.cat)}"`);
    out.push(`  date = "${tomlStr(it.date)}"`);
    // 简介：没有就不写这一行（模板会退回该分类的说明）
    if (String(it.desc ?? '').trim()) out.push(`  desc = "${tomlStr(it.desc)}"`);
    if (it.cover) out.push('  cover = true');
    out.push('');
  }
  return out.join('\n');
}


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

  /* ---------- 编辑器自身的版本 / 重启 ----------
     站长反馈过：「pull 下来编辑器也不会更新新功能」。
     原因是 —— ui.html 每次请求都现读（刷新页面就拿到新的），
     但 **server.mjs 是进程启动时加载的**，不重启就永远是旧代码。
     所以这里给出「当前跑的是哪一版」，前端发现落后就提示重启。 */
  if (p === '/api/version' && req.method === 'GET') {
    const st = async (rel) => {
      try { return Math.round((await fsp.stat(path.join(__dirname, rel))).mtimeMs); }
      catch { return 0; }
    };
    return json(res, 200, {
      startedAt: STARTED_AT,                       // 本进程启动时间
      serverFileAt: await st('server.mjs'),        // 磁盘上 server.mjs 的修改时间
      uiFileAt: await st('ui.html'),
    });
  }

  if (p === '/api/restart' && req.method === 'POST') {
    /* 留个标记再退出：start.cmd / start.command 看到标记会把进程重新拉起来。
       不写标记直接退，等于把编辑器关掉了。 */
    try {
      await fsp.writeFile(path.join(__dirname, 'restart-needed'), String(Date.now()), 'utf8');
    } catch (e) {
      return json(res, 500, { error: '写重启标记失败：' + e.message });
    }
    json(res, 200, { ok: true, restarting: true });
    setTimeout(() => process.exit(0), 120);
    return;
  }

  /* ---------- 静态页面 ---------- */
  if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
    let html = await fsp.readFile(path.join(__dirname, 'ui.html'), 'utf8');
    html = html.replace(/__TOKEN__/g, TOKEN);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(html);
  }

  /* ---------- 自己把 static/ 下的图供出来 ----------
     面板里的缩略图、挑图器、画廊预览都直接用 /images/xxx 这种站点路径。
     以前这些 <img> 是相对地址，会打到编辑器自己的端口（4321），而编辑器
     只服务 ui.html 和 /api/* —— 于是选图面板里 109 张图全是裂的
     （实测 4321 上 /images/… 404、1313 上 200）。
     这里兜住 /images/*，面板就不必依赖「预览服务器开着」这件事。
     只读、只认图片扩展名、限制在 static/ 目录内。 */
  if (req.method === 'GET' && p.startsWith('/images/')) {
    const rel = decodeURIComponent(p.slice('/images/'.length)).replace(/\\/g, '/');
    const IMG_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.bmp', '.svg', '.ico']);
    const ext = path.extname(rel).toLowerCase();
    if (rel.includes('..') || !IMG_EXT.has(ext)) { json(res, 404, { error: 'not found' }); return; }
    const full = safePath('static/images/' + rel);
    let buf = null;
    try { buf = await fsp.readFile(full); } catch { buf = null; }
    if (!buf) { json(res, 404, { error: 'not found' }); return; }
    const MIME = {
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
      '.gif': 'image/gif', '.avif': 'image/avif', '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
    };
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    return res.end(buf);
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
    } else if (kind === 'collection') {
      // 文集：绿色主题、窄侧栏那套由 content/collection/_index.md 的 cascade
      // 带下来（theme: collection），所以这里不用写 theme。
      rel = `content/collection/${clean}.md`;
      body = `---\ntitle: "${title}"\ndate: ${d}\ndraft: ${draftFlag}\ndescription: ""\n---\n\n在这里写正文。\n`;
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

  /* 列出 static/images 下的图（相对 /images/ 的路径 + 有没有缩略图 + 大小）。
     「画作」面板用它让站长直接引用站上已有的图，不用为了进画廊再传一份。
     缩略图放在 static/images/gallery/thumbs/，文件名里的 / 换成 __。 */
  if (p === '/api/gallery/images' && req.method === 'GET') {
    const root = safePath('static/images');
    const IMG = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif']);
    const list = [];
    async function walk(dir, rel) {
      let entries = [];
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        if (rel === '' && e.isDirectory() && e.name === 'gallery') continue;  // gallery 单独扫，跳过它自己的 thumbs
        const full = path.join(dir, e.name);
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (e.name === 'thumbs') continue;
          await walk(full, r);
          continue;
        }
        const ext = path.extname(e.name).toLowerCase();
        if (!IMG.has(ext)) continue;
        const st = await fsp.stat(full).catch(() => null);
        if (!st) continue;
        const thumbRel = thumbRelFor(r);
        const hasThumb = await fsp.stat(safePath(thumbRel)).catch(() => null);
        // 面板要拿它当预览图：有缩略图用缩略图，否则用原图。
        // 前缀必须是 /images/ —— 编辑器自己也供这条路径（见上面那个分支），
        // 所以不依赖预览服务器开着。
        const preview = hasThumb
          ? '/' + thumbRel.replace(/^static\//, '')
          : '/images/' + r;
        list.push({ file: r, bytes: st.size, thumb: !!hasThumb, preview: preview });
      }
    }
    await walk(root, '');
    await walk(path.join(root, 'gallery'), 'gallery');
    list.sort((a, b) => a.file.localeCompare(b.file));
    return json(res, 200, { items: list, count: list.length });
  }

  /* 给指定的图补生成缩略图。只处理「需要且还没有」的，重复跑是安全的。
     传进来的是相对 /images/ 的路径（和列表里给的一致）。 */
  if (p === '/api/gallery/thumbs' && req.method === 'POST') {
    const { files } = await readBody(req);
    if (!Array.isArray(files) || !files.length) throw new Error('要给哪些图生成缩略图？');
    const done = [];
    for (const f of files) {
      const rel = String(f || '').replace(/\\/g, '/').replace(/^\/+/, '');
      if (!rel || rel.includes('..') || rel.startsWith('static')) {
        done.push({ file: rel, ok: false, error: '路径不合法' });
        continue;
      }
      if (path.extname(rel).toLowerCase() === '.webp') {
        done.push({ file: rel, ok: true, skipped: '本来就是 webp' });
        continue;
      }
      if (!await fsp.stat(safePath(`static/images/${rel}`)).catch(() => null)) {
        done.push({ file: rel, ok: false, error: '找不到这个文件' });
        continue;
      }
      const dst = thumbRelFor(rel);
      if (await fsp.stat(safePath(dst)).catch(() => null)) {
        done.push({ file: rel, ok: true, skipped: '已经有缩略图了' });
        continue;
      }
      const r = runThumbScript(`static/images/${rel}`, dst);
      done.push(Object.assign({ file: rel }, r));
    }
    const failed = done.filter((x) => x.ok === false);
    return json(res, 200, { ok: failed.length === 0, done, failed: failed.length });
  }

  /* ---------- 图片上传（拖拽 / 选择）----------
     默认落到 static/images/（正文插图用）。
     dir 可以指定 static/images 下的子目录（画廊面板传 images/gallery），
     此时顺手用 tools/make-thumb.py 生成一张 webp 缩略图 —— 画廊一页几十张画，
     直接上原图就是几十 MB，缩略图让首屏只背几十 KB。（Hugo 的图片管线读不到
     static/，所以这一步只能在上传时做。）缩略图失败不影响上传本身。 */
  if (p === '/api/upload' && req.method === 'POST') {
    const { name, data, dir: wantDir, thumb: wantThumb } = await readBody(req);
    if (!data) throw new Error('没有收到图片数据');
    const buf = Buffer.from(String(data).replace(/^data:[^;]+;base64,/, ''), 'base64');
    if (!buf.length) throw new Error('图片是空的');

    let clean = String(name || 'image').replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, '-');
    if (!/\.[a-z0-9]+$/i.test(clean)) clean += '.png';

    let dir = 'static/images';
    if (wantDir) {
      const sub = String(wantDir).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
      if (sub.includes('..') || !/^images(\/[A-Za-z0-9._-]+)*$/.test(sub)) {
        throw new Error('目录只能是 static/images 下面的子目录：' + sub);
      }
      dir = 'static/' + sub;
    }
    await fsp.mkdir(safePath(dir), { recursive: true });

    // 重名就加序号
    const dot = clean.lastIndexOf('.');
    const stem = clean.slice(0, dot), ext = clean.slice(dot);
    let final = clean, n = 1;
    while (await fsp.stat(safePath(`${dir}/${final}`)).catch(() => null)) {
      final = `${stem}-${n++}${ext}`;
    }
    await fsp.writeFile(safePath(`${dir}/${final}`), buf);

    const rel = `${dir}/${final}`;
    const out = { ok: true, url: '/' + rel.replace(/^static\//, ''), rel, bytes: buf.length };

    // 画廊那种大图：顺手压一张缩略图（统一放 gallery/thumbs/）
    if (wantThumb !== false && dir !== 'static/images') {
      const relFromImages = rel.replace(/^static\/images\//, '');
      const r = runThumbScript('static/' + rel.replace(/^static\//, ''), thumbRelFor(relFromImages));
      out.thumb = r;
    }
    return json(res, 200, out);
  }

  /* ---------- 音频上传（音乐播放器用） ----------
     和图片上传同一个套路：前端读成 dataURL 发过来，这里落到 static/music/。
     重名不覆盖，自动加 -1 -2，免得手滑把已经排好的曲子顶掉。
     只认音频扩展名：这个目录是站点公开目录，别让它变成万能文件柜。 */
  if (p === '/api/upload-audio' && req.method === 'POST') {
    const { name, data } = await readBody(req);
    if (!data) throw new Error('没有收到音频数据');
    const buf = Buffer.from(String(data).replace(/^data:[^;]+;base64,/, ''), 'base64');
    if (!buf.length) throw new Error('文件是空的');

    const raw = String(name || 'audio').replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, '-').replace(/\.{2,}/g, '.');
    const dot = raw.lastIndexOf('.');
    const ext = (dot > 0 ? raw.slice(dot) : '').toLowerCase();
    if (!AUDIO_EXT.has(ext)) {
      throw new Error('只收音频文件（' + [...AUDIO_EXT].join(' / ') + '）');
    }
    const stem = dot > 0 ? raw.slice(0, dot) : raw;

    const dir = 'static/music';
    await fsp.mkdir(safePath(dir), { recursive: true });
    let final = raw, n = 1;
    while (await fsp.stat(safePath(`${dir}/${final}`)).catch(() => null)) {
      final = `${stem}-${n++}${ext}`;
    }
    await fsp.writeFile(safePath(`${dir}/${final}`), buf);
    return json(res, 200, { ok: true, file: final, dir, bytes: buf.length,
      url: '/' + dir.replace(/^static\//, '') + '/' + final });
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

  // 顶部导航栏（[[menu.main]]）—— 「站点设置」只管 [params]，所以单开一组接口
  if (p === '/api/menu' && req.method === 'GET') {
    return json(res, 200, { items: parseMenu(await readText('hugo.toml')) });
  }
  if (p === '/api/menu' && req.method === 'POST') {
    const { items } = await readBody(req);
    if (!Array.isArray(items)) throw new Error('参数不对：需要 items 数组');
    const clean = items
      .map((it) => ({
        name: String(it.name || '').trim(),
        pageRef: String(it.pageRef || it.url || '').trim(),
      }))
      .filter((it) => it.name);
    for (const it of clean) {
      if (!it.pageRef) throw new Error(`「${it.name}」还没选指向哪个页面`);
    }
    const next = writeMenu(await readText('hugo.toml'), clean);
    await writeText('hugo.toml', next);
    return json(res, 200, { ok: true, count: clean.length, items: parseMenu(next) });
  }

  /* ---------- 文集：分册 + 文章归属 + 标签 ---------- */
  if (p === '/api/collection' && req.method === 'GET') {
    return json(res, 200, {
      books: await readCollectionBooks(),
      articles: await listCollectionArticles(),
      booksFile: COLLECTION_BOOKS_FILE,
    });
  }

  if (p === '/api/collection/books' && req.method === 'POST') {
    const { books } = await readBody(req);
    if (!Array.isArray(books)) throw new Error('参数不对：需要 books 数组');
    const clean = await writeCollectionBooks(books);
    return json(res, 200, { ok: true, count: clean.length, books: clean });
  }

  if (p === '/api/collection/articles' && req.method === 'POST') {
    const { articles } = await readBody(req);
    if (!Array.isArray(articles)) throw new Error('参数不对：需要 articles 数组');
    const saved = [];
    const rescued = [];                       // 正文里漏出的字段被收回来的文章
    for (const a of articles) {
      const rel = String(a.file || '');
      // 只允许改文集目录里的文章，别的一个都不碰
      if (!rel.startsWith('content/collection/') || /_index\.md$/.test(rel)) {
        throw new Error('只能改 content/collection/ 里的文章：' + rel);
      }
      const rawText = await readText(rel);
      // 手改时容易把 book/weight/… 打在结束的 --- 下面，那样会在页面上当正文显示出来。
      // 先收回，再写 front matter（面板里填了以面板为准，面板空着就把漏出来的值救回去）。
      const hoisted = hoistLeakedCollectionParams(rawText);
      const text = hoisted.text;
      const mv = hoisted.moved;
      const weight = String(a.weight ?? '').trim();
      const tags = Array.isArray(a.tags)
        ? a.tags.map((t) => String(t).trim()).filter(Boolean)
        : String(a.tags || '').split(/[,，]/).map((t) => t.trim()).filter(Boolean);
      const next = setFrontMatter(text, {
        book: a.book ? String(a.book) : (mv.book || null),
        weight: weight !== '' ? Number(weight) : (mv.weight === undefined ? null : mv.weight),
        essay: a.essay === true ? true : (mv.essay === true ? true : null),
        r18: a.r18 === true ? true : (mv.r18 === true ? true : null),
        collection_tags: tags.length ? tags : (Array.isArray(mv.collection_tags) ? mv.collection_tags : []),
      });
      if (next !== rawText) await writeText(rel, next);
      if (hoisted.dropped) rescued.push(rel);
      saved.push(rel);
    }
    return json(res, 200, { ok: true, count: saved.length, saved, rescued });
  }

  if (p.startsWith('/api/list/')) {
    const which = p.split('/')[3];
    const spec = DATA_LISTS[which];
    if (!spec) return json(res, 404, { error: '没有这个列表：' + which });

    if (req.method === 'GET') {
      const raw = await readText(spec.file);
      const items = parseItems(raw);
      // 音乐这份顺带告诉自己（和编辑器）哪些音频其实不在
      if (spec.music) {
        const status = await musicFileStatus(items);
        return json(res, 200, { items, keys: spec.keys, status,
          missing: status.filter((s) => !s.exists && !s.external).map((s) => s.file) });
      }
      // 画廊：分类也一起给，面板还要用它当下拉框；顺带报「图片文件不在」的
      if (spec.gallery) {
        const sections = parseGallerySections(raw);
        const missing = [];
        for (const it of items) {
          const f = String(it.file || '').trim();
          if (f && !await fsp.stat(safePath(`static/images/${f}`)).catch(() => null)) missing.push(f);
        }
        return json(res, 200, { items, sections, keys: spec.keys, missing });
      }
      return json(res, 200, { items, keys: spec.keys });
    }

    // ⚠️ 请求体只能读一次：readBody(req) 把整个 body 收干，再调一次拿到的是空对象。
    // 画廊那份要 items + sections 两样，所以在这里读一次、两个都拆出来。
    const body = await readBody(req);
    let items = Array.isArray(body.items) ? body.items : null;
    if (!items) throw new Error('参数不对：需要 items 数组');
    const rawSections = Array.isArray(body.sections) ? body.sections : null;

    if (which === 'music') {
      // 空行（点了「加一条」还没填文件名的）丢掉；顺手把结果里的「文件不在」报回去
      const clean = items
        .map((it) => ({
          file: String(it.file || '').trim(),
          title: String(it.title || '').trim(),
          artist: String(it.artist || '').trim(),
        }))
        .filter((it) => it.file);
      const bad = clean.filter((it) => !isExternalFile(it.file)
        && (it.file.includes('/') || !musicPathFor(it.file)));
      if (bad.length) throw new Error('文件名只写 static/music/ 里的那个名字，不带目录或 ..：「' + bad.map((x) => x.file).join('、') + '」');

      const cur = await readMusicFile();
      await writeText(spec.file, writeMusicFile(MUSIC_HEADER, clean, cur));

      const status = await musicFileStatus(clean);
      return json(res, 200, { ok: true, count: clean.length, status,
        missing: status.filter((s) => !s.exists && !s.external).map((s) => s.file) });
    }

    if (which === 'gallery') {
      const sections = (rawSections || parseGallerySections(await readText(spec.file)))        .map((s) => ({
          id: String(s.id || '').trim(),
          name: String(s.name || '').trim(),
          desc: String(s.desc || '').trim(),
        }))
        .filter((s) => s.id && s.name);
      for (const s of sections) {
        if (!/^[A-Za-z0-9_-]+$/.test(s.id)) {
          throw new Error('分类 id 只能用字母数字和 - _（它是页面锚点）：「' + s.id + '」');
        }
      }
      const ids = new Set(sections.map((s) => s.id));
      if (ids.size !== sections.length) throw new Error('分类 id 有重复');

      const clean = items
        .map((it) => ({
          title: String(it.title || '').trim(),
          file: String(it.file || '').trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/^images\//, ''),
          cat: String(it.cat || '').trim(),
          date: String(it.date || '').trim().slice(0, 10),
          desc: String(it.desc || '').trim(),
          cover: !!it.cover,
        }))
        .filter((it) => it.title || it.file);

      for (const it of clean) {
        if (!it.file) throw new Error(`「${it.title || '（没写标题）'}」还没选图片`);
        if (it.file.includes('..')) throw new Error('图片路径不能带 ..：「' + it.file + '」');
        if (!it.cat) throw new Error(`「${it.title || it.file}」还没选分类`);
        if (!ids.has(it.cat)) throw new Error(`「${it.title || it.file}」的分类不认识：${it.cat}`);
        if (it.date && !/^\d{4}-\d{2}-\d{2}$/.test(it.date)) {
          throw new Error(`创作日期要写成 YYYY-MM-DD：「${it.date}」`);
        }
        if (!/[."']$/.test(it.file) && !/\.[A-Za-z0-9]+$/.test(it.file)) {
          throw new Error(`图片路径要带扩展名：「${it.file}」`);
        }
      }

      await writeText(spec.file, writeGalleryFile(GALLERY_HEADER, sections, clean));

      /* 写完再数一遍：条数对不上就报错，别返回一个「成功」把数据丢了。
         （出过一次真事故：请求体被读了两次，items 变成空数组，
           结果把整个画廊清空、接口还返回 200 ok —— 编辑器以为保存成功了。） */
      const written = parseItems(await readText(spec.file));
      if (written.length !== clean.length) {
        throw new Error(`保存后条数不对：打算写 ${clean.length} 条，实际落盘 ${written.length} 条`);
      }

      const missing = [];
      for (const it of clean) {
        if (!await fsp.stat(safePath(`static/images/${it.file}`)).catch(() => null)) missing.push(it.file);
      }
      return json(res, 200, { ok: true, count: clean.length, sections: sections.length, missing });
    }

    if (which === 'updates' || which === 'notices') {
      // 「日期 + 一句话 + 可选链接」。更新日志还支持「同一日期多条」（text = [...]）。
      const isArr = (v) => Array.isArray(v);
      const hasBody = (it) => {
        const a = it.text, t = it.title;
        return String(it.date || '').trim()
          || (isArr(a) ? a.length : String(a || '').trim())
          || String(t || '').trim();
      };
      items = items.filter(hasBody);

      const today = new Date().toISOString().slice(0, 10);
      for (const it of items) {
        // 日期写坏的话 Hugo 构建会直接报错（模板里要 time 解析它），所以这里先拦住
        let d = String(it.date || '').trim().slice(0, 10);
        if (!d) d = today;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error(`日期要写成 YYYY-MM-DD：「${it.date}」`);
        it.date = d;

        // 更新日志的「子条目」标记：true 才写 indent = true，否则去掉这个字段
        if (it.indent === true) it.indent = true; else delete it.indent;

        if (isArr(it.text)) {
          // 多行写法：清理空行；只剩一行的话退回单行（文件更干净）
          const lines = it.text.map((x) => String(x ?? '').trim()).filter(Boolean);
          if (lines.length === 1) { it.title = lines[0]; delete it.text; }
          else if (lines.length > 1) { delete it.title; }
          else { delete it.text; it.title = '（没写内容）'; }
        } else {
          const body = String(it[which === 'updates' ? 'title' : 'text'] || '').trim();
          if (which === 'updates') it.title = body || '（没写标题）';
          else it.text = body || '（没写内容）';
        }
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

  /* ---------- 宝可梦放养区的台词 ---------- */
  if (p === '/api/pkmn' && req.method === 'GET') {
    const list = parsePkmnPoolList(await readText('data/pkmn-pool.toml'));
    const items = [];
    for (const it of list) {
      const dex = Number(it.dex);
      let exists = false;
      let total = 0;
      try {
        const d = parsePkmnTalk(await readText(`${PKMN_DIR}/${dex}.toml`));
        exists = !!d.name;
        if (exists) {
          const count = (o, keys) => keys.reduce((n, [k]) => n + ((o[k] || []).length), 0);
          total = count(d.pools, PKMN_POOLS) + count(d.page, PKMN_PAGE) + count(d.weather, PKMN_WEATHER);
        }
      } catch { /* 文件还没写出来 */ }
      items.push({
        dex, name: String(it.name || dex), en: String(it.en || ''),
        sleep: it.sleep === 'day' ? 'day' : 'night', exists, total,
      });
    }
    return json(res, 200, {
      items,
      groups: { pools: PKMN_POOLS, page: PKMN_PAGE, weather: PKMN_WEATHER },
      pythonOk,
      pythonNote,
      python: PYTHON,
    });
  }

  if (p.startsWith('/api/pkmn/')) {
    const dex = String(p.split('/')[3] || '').replace(/\D/g, '');
    if (!dex) return json(res, 400, { error: '图鉴号不对：' + p });

    if (req.method === 'GET') {
      const d = parsePkmnTalk(await readText(`${PKMN_DIR}/${dex}.toml`));
      return json(res, 200, Object.assign({ dex: Number(dex), exists: !!d.name }, d));
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      const name = String(body.name || '').trim();
      if (!name) throw new Error('缺少 name，没法写回文件');
      const norm = (o, keys) => {
        const out = {};
        for (const [k] of keys) {
          const v = (o && Array.isArray(o[k])) ? o[k] : [];
          out[k] = v.map((s) => String(s).replace(/[\r\n]+/g, ' ').trim());
        }
        return out;
      };
      const data = {
        header: String(body.header || ''),
        pools: norm(body.pools, PKMN_POOLS),
        page: norm(body.page, PKMN_PAGE),
        weather: norm(body.weather, PKMN_WEATHER),
        order: body.order && typeof body.order === 'object' ? {
          pools: Array.isArray(body.order.pools) ? body.order.pools.map(String) : [],
          page: Array.isArray(body.order.page) ? body.order.page.map(String) : [],
          weather: Array.isArray(body.order.weather) ? body.order.weather.map(String) : [],
        } : null,
      };
      await writeText(`${PKMN_DIR}/${dex}.toml`, writePkmnTalk(dex, name, data));

      // 页面读的是生成出来的 JSON，所以这里顺手重新生成一次（不联网，一秒左右）
      let log = '';
      let code = 0;
      if (pythonOk) {
        // Windows 上 python 默认按本地代码页（cp936）输出中文，Node 按 utf8 收就会变乱码，
        // 所以强制它用 UTF-8 —— 面板上要显示生成脚本的报错，乱码就没法看了。
        const r = await run(PYTHON, ['tools/build-pkmn.py', '--talk'], {
          env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
        });
        code = r.code;
        log = (r.stdout + r.stderr).trim();
      } else {
        code = 1;
        log = pythonNote + '\n（台词文件已经存好，但 static/pkmn/talk/*.json 没有更新。）';
      }
      return json(res, 200, { ok: code === 0, code, log: tail(log, 2000) });
    }
  }

  /* ---------- 始祖小鸟页放养区的台词 ---------- */
  if (p === '/api/tbtak' && req.method === 'GET') {
    let files = [];
    try { files = (await listDir(TBTAK_DIR)).filter((f) => f.endsWith('.toml')).sort(); } catch { files = []; }
    const items = [];
    for (const rel of files) {
      const id = rel.split('/').pop().replace(/\.toml$/, '');
      let name = id;
      let total = 0;
      let exists = false;
      try {
        const d = parseTbtakTalk(await readText(rel));
        exists = !!d.name;
        name = d.name || id;
        total = TBTAK_POOLS.reduce((n, [k]) => n + ((d.pools[k] || []).length), 0);
      } catch { /* 读不了就只报个 id */ }
      items.push({ id, name, exists, total });
    }
    return json(res, 200, { items, groups: TBTAK_POOLS, optional: [...TBTAK_OPTIONAL], pythonOk, pythonNote, python: PYTHON });
  }

  if (p.startsWith('/api/tbtak/')) {
    const id = String(p.split('/')[3] || '');
    // 只允许 data/tbtak-talk/ 里的普通文件名，别的一个都不碰
    if (!/^[A-Za-z0-9_-]+$/.test(id)) return json(res, 400, { error: '角色 id 不对：' + p });

    if (req.method === 'GET') {
      const d = parseTbtakTalk(await readText(`${TBTAK_DIR}/${id}.toml`));
      return json(res, 200, Object.assign({ id, exists: !!d.name }, d));
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      const name = String(body.name || '').trim();
      if (!name) throw new Error('缺少 name，没法写回文件');
      const pools = {};
      for (const [k] of TBTAK_POOLS) {
        const v = (body.pools && Array.isArray(body.pools[k])) ? body.pools[k] : [];
        pools[k] = v.map((s) => String(s).replace(/[\r\n]+/g, ' ').trim());
      }
      await writeText(`${TBTAK_DIR}/${id}.toml`,
        writeTbtakTalk(id, { header: String(body.header || ''), name, pools }));

      // 页面读的是 static/tbtak/talk/<id>.json，所以顺手重新生成一次
      // （--talk 不碰素材，也不需要本机有游戏工程）
      let log = '';
      let code = 0;
      if (pythonOk) {
        const r = await run(PYTHON, ['tools/build-tbtak.py', '--talk'], {
          env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
        });
        code = r.code;
        log = (r.stdout + r.stderr).trim();
      } else {
        code = 1;
        log = pythonNote + '\n（台词文件已经存好，但 static/tbtak/talk/*.json 没有更新。）';
      }
      return json(res, 200, { ok: code === 0, code, log: tail(log, 2000) });
    }
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
    return json(res, 200, await gitState(true));
  }

  if (p === '/api/git' && req.method === 'POST') {
    const { action, message } = await readBody(req);
    const steps = [];
    const note = (text) => steps.push({ code: 0, stdout: text, stderr: '', note: text });
    let retried = false, conflict = false;

    if (action === 'commit' || action === 'commitpush') {
      steps.push(await git(['add', '-A']));
      const st = await git(['status', '--porcelain']);
      if (st.stdout.trim()) {
        steps.push(await git(['commit', '-m', message || '更新']));
      } else {
        // 注意：这里**不能直接 return**。上一次推送失败的话，改动早就提交在本地了，
        // 工作区是干净的 —— 早退就永远推不上去了（站长报的就是这个）。
        note(action === 'commit'
          ? '没有新的改动要提交'
          : '没有新的改动要提交，直接推送本地已有的提交');
      }
    }

    if (action === 'pull') {
      const pull = await run('git', ['pull', '--rebase', '--autostash', 'origin', 'main'],
        { timeout: 60000 });
      steps.push(pull);
      if (pull.code !== 0) conflict = true;
    }

    if (action === 'push' || action === 'commitpush') {
      const push = await run('git', ['push', 'origin', 'main'], { timeout: 60000 });
      steps.push(push);
      if (push.code !== 0) {
        // 多半是另一台电脑推过了（non-fast-forward）：先把自己的提交 rebase 到线上，再推一次
        retried = true;
        note('推送被拒，先拉取线上改动再试一次');
        const pull = await run('git', ['pull', '--rebase', '--autostash', 'origin', 'main'],
          { timeout: 60000 });
        steps.push(pull);
        if (pull.code === 0) {
          steps.push(await run('git', ['push', 'origin', 'main'], { timeout: 60000 }));
        } else {
          conflict = true;      // rebase 撞车了：留给人工解决，别把历史搞乱
          note('拉取时冲突了：本地和线上改了同一处，按提示手工解决之后再发布一次。');
        }
      }
    }

    fetchAt = 0;                                  // 状态变了，下次重新 fetch
    const state = await gitState(true);
    // 「成功」看的是**结果**：本地提交都推上去了就算成功 ——
    // 第一次被拒、自动重试之后推上去的也算（不然页面上会红着脸说失败，其实已经发出去了）。
    return json(res, 200, {
      ok: state.ahead === 0,
      retried, conflict,
      state,
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
