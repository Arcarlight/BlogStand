/* ============================================================
   /api/diary —— 写某一天的日记（契约 §3.3 / §4）
   GET  ?year=&month= -> {path, exists, text, days:[{day,id,date}]}
   POST {year, month, day, html}
        -> {ok:true, path, sha, commit, htmlUrl, text}

   日记一个月一个文件，每天一个 <h2><span id="MMDD">…</span></h2> 小节：
     - 文件不存在：先用 §3.2 模板生成整月文件，再写入当天小节
     - 当天小节已存在：替换正文（保留标题行）
     - 不存在：按 id 顺序插到第一个更大的日标题前；没有更大的就插到
       <!--more--> 前；没有 <!--more--> 就追加到文件末尾
   ============================================================ */

import {
  HttpError,
  applyDiaryDay,
  assertWritablePath,
  commitFiles,
  daysInMonth,
  diaryFileTemplate,
  diaryRepoPath,
  extractDiaryDays,
  getFile,
  json,
  readJsonBody,
  touchLastmod,
} from './_shared.js';

function parseYearMonth(url) {
  const year = Number(url.searchParams.get('year'));
  const month = Number(url.searchParams.get('month'));
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new HttpError(400, 'year 不对');
  if (!Number.isInteger(month) || month < 1 || month > 12) throw new HttpError(400, 'month 不对');
  return { year, month };
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const { year, month } = parseYearMonth(url);
  const path = assertWritablePath(diaryRepoPath(year, month));

  const file = await getFile(env, path);
  const text = file.exists && typeof file.text === 'string' ? file.text : '';
  return json({
    path,
    exists: !!file.exists,
    text,
    days: extractDiaryDays(text, year, month),
  });
}

export async function onRequestPost({ request, env }) {
  const body = await readJsonBody(request, 1 * 1024 * 1024);

  const year = Number(body.year);
  const month = Number(body.month);
  const day = Number(body.day);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new HttpError(400, 'year 不对');
  if (!Number.isInteger(month) || month < 1 || month > 12) throw new HttpError(400, 'month 不对');
  if (!Number.isInteger(day) || day < 1 || day > daysInMonth(year, month)) {
    throw new HttpError(400, 'day 不对');
  }
  if (body.html != null && typeof body.html !== 'string') throw new HttpError(400, 'html 必须是字符串');
  const html = body.html == null ? '' : body.html;

  const path = assertWritablePath(diaryRepoPath(year, month));

  const current = await getFile(env, path);
  const oldText = current.exists && typeof current.text === 'string' ? current.text : '';
  const base = current.exists ? oldText : diaryFileTemplate(year, month, false);

  let text = applyDiaryDay(base, year, month, day, html);
  // 正文变了就刷新 lastmod（新建月文件也补上）
  text = touchLastmod(oldText, text);

  const result = await commitFiles(
    env,
    [{ path, content: text }],
    `mobile-editor: 日记 ${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  );
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
