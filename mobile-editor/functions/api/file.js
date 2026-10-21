/* ============================================================
   /api/file —— 单文件读写（契约 §4）
   GET  ?path=            -> {path, text, sha}；不存在 404 {error:"not found", sha:null}
   PUT  {path,text,sha,force?} -> {ok:true, path, sha, commit, htmlUrl}
        sha 不匹配 -> 409 {error:"conflict", sha, text}（除非 force:true）

   content/*.md 保存时正文变了会刷新 front matter 的 lastmod（契约 §3.1）。
   ============================================================ */

import {
  HttpError,
  assertReadablePath,
  assertWritablePath,
  commitFiles,
  getFile,
  json,
  readJsonBody,
  touchLastmod,
} from './_shared.js';

const PUT_MAX_BYTES = 16 * 1024 * 1024;

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const path = assertReadablePath(url.searchParams.get('path') || '');
  const file = await getFile(env, path);
  if (!file.exists) {
    return json({ error: 'not found', sha: null }, 404);
  }
  return json({ path, text: file.text == null ? '' : file.text, sha: file.sha });
}

export async function onRequestPut({ request, env }) {
  const body = await readJsonBody(request, PUT_MAX_BYTES, '文件太大，最多 16MB');
  const path = assertWritablePath(body.path || '');

  if (body.text == null || typeof body.text !== 'string') {
    throw new HttpError(400, '缺少 text');
  }
  if (body.sha == null || typeof body.sha !== 'string' || !body.sha.trim()) {
    throw new HttpError(400, '缺少 sha（新建文件请走 /api/new）');
  }
  const force = body.force === true;
  let text = body.text;

  const current = await getFile(env, path);
  if (!current.exists) {
    // 服务端已经没有这个文件了：sha 再新也对不上
    if (!force) throw new HttpError(409, 'conflict', { sha: null, text: null });
  } else if (current.sha !== body.sha && !force) {
    throw new HttpError(409, 'conflict', { sha: current.sha, text: current.text });
  }

  // 正文有变化才刷 lastmod（新建/强制覆盖时旧文本当空串）
  if (/^content\/.*\.md$/i.test(path)) {
    text = touchLastmod(current.text || '', text);
  }

  const result = await commitFiles(
    env,
    [{ path, content: text }],
    `mobile-editor: 更新 ${path}`
  );
  const written = result.files.find((f) => f.path === path) || result.files[0];

  return json({
    ok: true,
    path,
    sha: written ? written.sha : null,
    commit: result.commit,
    htmlUrl: result.htmlUrl,
    // 额外给前端一份写入后的文本（lastmod 可能被刷新过）
    text,
  });
}
