/* ============================================================
   /api/list —— 文章 / 日记 / 页面 / 文集列表（契约 §4）
   GET ?kind=blog|niki|page|collection
   -> {kind, items:[{path,name,title,date,draft,lastmod,dayIds?}], fetchedAt}

   做法：
     1. git/ trees?recursive=1 拿分支上所有 blob 路径
     2. 按 kind 过滤出 .md
     3. 以最多 6 并发拉正文，解析 front matter 的 title/date/draft/lastmod
     4. 结果在 isolate 内存缓存 5 分钟（key 含 branch）

   单篇解析失败只影响那一篇（用文件名兜底），不整页报错。
   ============================================================ */

import { getFile, json, listCache, listTreePaths, mapLimit, parseFrontMatter } from './_shared.js';

const CACHE_TTL_MS = 5 * 60 * 1000;
const CONCURRENCY = 6;
const KINDS = new Set(['blog', 'niki', 'page', 'collection']);

/* key: `${branch}|${kind}` -> {at, items, fetchedAt}
   缓存在 _shared.js 里（名字 listCache）：写入成功后那边会 clear()，
   保证「刚保存的文章马上就出现在列表里」。 */
const cache = listCache;

function basename(path) {
  return String(path).split('/').pop() || '';
}

function stem(path) {
  return basename(path).replace(/\.md$/i, '');
}

function matchKind(kind, path) {
  if (kind === 'blog') return /^content\/blog\/[^/]+\.md$/i.test(path);
  if (kind === 'niki') return /^content\/niki\/[^/]+\.md$/i.test(path);
  if (kind === 'collection') return /^content\/collection\/[^/]+\.md$/i.test(path);
  if (kind === 'page') return /^content\/[^/]+\.md$/i.test(path);
  return false;
}

/** 下划线开头的是 _index.md 之类，列表里不出现 */
function isListable(path) {
  return !basename(path).startsWith('_');
}

function dayIdsOf(text) {
  const ids = [];
  const seen = new Set();
  const re = /<span\s+id=["'](\d{2})(\d{2})["']/g;
  let m;
  while ((m = re.exec(String(text || '')))) {
    if (seen.has(m[2])) continue;
    seen.add(m[2]);
    ids.push(m[2]);
  }
  return ids;
}

function sortItems(items) {
  items.sort((a, b) => {
    if (a.date && b.date && a.date !== b.date) return a.date < b.date ? 1 : -1;
    if (a.date && !b.date) return -1;
    if (!a.date && b.date) return 1;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });
  return items;
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const kind = (url.searchParams.get('kind') || 'blog').trim();
  if (!KINDS.has(kind)) return json({ error: 'kind 不支持' }, 400);

  const branch = (env && env.GITHUB_BRANCH) || 'main';
  const key = `${branch}|${kind}`;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_TTL_MS) {
    return json({ kind, items: hit.items, fetchedAt: hit.fetchedAt });
  }

  const { paths } = await listTreePaths(env);
  const files = paths.filter((p) => matchKind(kind, p) && isListable(p));

  const items = await mapLimit(files, CONCURRENCY, async (path) => {
    const item = {
      path,
      name: stem(path),
      title: stem(path),
      date: '',
      draft: false,
      lastmod: null,
    };
    let text = '';
    try {
      const file = await getFile(env, path);
      if (!file.exists || typeof file.text !== 'string') return null;
      text = file.text;
      const fm = parseFrontMatter(text);
      if (fm.title) item.title = fm.title;
      if (fm.date) item.date = fm.date;
      if (fm.lastmod) item.lastmod = fm.lastmod;
      item.draft = !!fm.draft;
    } catch (e) {
      // 单篇读失败：保留文件名兜底，不影响整个列表
      // （GitHub 整体故障会在 listTreePaths 那一步就抛出来）
      return item;
    }
    if (kind === 'niki') item.dayIds = dayIdsOf(text);
    return item;
  });

  const clean = sortItems(items.filter(Boolean));
  const fetchedAt = new Date().toISOString();
  cache.set(key, { at: now, items: clean, fetchedAt });
  return json({ kind, items: clean, fetchedAt });
}
