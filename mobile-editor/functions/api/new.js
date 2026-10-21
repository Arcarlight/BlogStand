/* ============================================================
   /api/new —— 新建文件（契约 §3.2 / §4）
   POST {kind, name, title, date?, draft?, text?}
   -> {ok:true, path, sha, commit, htmlUrl, text}；已存在 409

   kind:
     blog       content/blog/{name}.md
     page       content/{name}.md
     collection content/collection/{name}.md
     niki       content/niki/{name}.md（整月日记模板，name 形如 niki_202610）

   text 给了就直接写它（一次提交），否则写模板。
   ============================================================ */

import {
  HttpError,
  assertWritablePath,
  beijingDate,
  commitFiles,
  diaryFileTemplate,
  getFile,
  json,
  readJsonBody,
  sanitizeFileName,
} from './_shared.js';

const KINDS = new Set(['blog', 'page', 'collection', 'niki']);

function escTitle(title) {
  return String(title == null ? '' : title)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}

function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.trim()) ? value.trim() : '';
}

function blogTemplate(title, date, draft) {
  return (
    '---\n' +
    `title: "${escTitle(title)}"\n` +
    `date: ${date}\n` +
    `draft: ${draft ? 'true' : 'false'}\n` +
    'tags: []\n' +
    'description: ""\n' +
    '---\n\n' +
    '在这里写正文。\n\n' +
    '<!--more-->\n'
  );
}

function pageTemplate(title, draft) {
  return (
    '---\n' +
    `title: "${escTitle(title)}"\n` +
    `draft: ${draft ? 'true' : 'false'}\n` +
    'description: ""\n' +
    '---\n\n' +
    '在这里写内容。\n'
  );
}

function collectionTemplate(title, date, draft) {
  return (
    '---\n' +
    `title: "${escTitle(title)}"\n` +
    `date: ${date}\n` +
    `draft: ${draft ? 'true' : 'false'}\n` +
    'description: ""\n' +
    '---\n\n' +
    '在这里写正文。\n'
  );
}

export async function onRequestPost({ request, env }) {
  const body = await readJsonBody(request, 2 * 1024 * 1024);

  const kind = String(body.kind || 'page').trim();
  if (!KINDS.has(kind)) throw new HttpError(400, 'kind 不支持');

  const name = sanitizeFileName(body.name);
  if (!name) throw new HttpError(400, '文件名不能为空');
  const title = body.title == null ? name : String(body.title);
  const date = validDate(body.date) || beijingDate();
  const draft = body.draft === undefined ? true : !!body.draft;

  let path;
  let text;
  if (body.text != null && typeof body.text === 'string') {
    text = body.text;
  }

  if (kind === 'blog') {
    path = `content/blog/${name}.md`;
    if (text === undefined) text = blogTemplate(title, date, draft);
  } else if (kind === 'collection') {
    path = `content/collection/${name}.md`;
    if (text === undefined) text = collectionTemplate(title, date, draft);
  } else if (kind === 'niki') {
    // 年月优先从文件名 niki_YYYYMM 里取，取不到就用 date
    let year;
    let month;
    const mm = name.match(/(\d{4})\D?(\d{2})/);
    if (mm) {
      year = Number(mm[1]);
      month = Number(mm[2]);
    } else {
      year = Number(date.slice(0, 4));
      month = Number(date.slice(5, 7));
    }
    if (!(month >= 1 && month <= 12)) throw new HttpError(400, '从文件名或日期里读不出月份: ' + name);
    path = `content/niki/${name}.md`;
    if (text === undefined) text = diaryFileTemplate(year, month, draft);
  } else {
    path = `content/${name}.md`;
    if (text === undefined) text = pageTemplate(title, draft);
  }

  path = assertWritablePath(path);

  const current = await getFile(env, path);
  if (current.exists) throw new HttpError(409, '文件已存在: ' + path);

  const result = await commitFiles(env, [{ path, content: text }], `mobile-editor: 新建 ${path}`);
  const written = result.files.find((f) => f.path === path) || result.files[0];

  return json({
    ok: true,
    path,
    sha: written ? written.sha : null,
    commit: result.commit,
    htmlUrl: result.htmlUrl,
    text,
  });
}
