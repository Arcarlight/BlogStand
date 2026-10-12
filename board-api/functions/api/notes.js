/* ============================================================
   /api/notes —— 布告栏的门面
   ------------------------------------------------------------
     GET    ?limit=40   公开列表（只给 visible）
     POST               匿名贴一张（限流 + 蜜罐 + 提交耗时）
     DELETE             发帖人拿自己的 token 自己撤下来（软删）

   GET 出去的字段只有 id/name/color/body/at/reply，
   ip_hash、token_hash、status 一个都不出去。
   ============================================================ */

import {
  BODY_MAX,
  NAME_MAX,
  MIN_ELAPSED_MS,
  bumpRate,
  checkRate,
  clampLimit,
  cleanText,
  fail,
  ipHashOf,
  json,
  normalizeColor,
  nowCN,
  preflight,
  readJson,
  sha256Hex,
  toNote
} from './_shared.js';

export async function onRequestOptions({ request }) {
  return preflight(request);
}

export async function onRequestGet({ request, env }) {
  const limit = clampLimit(new URL(request.url).searchParams.get('limit'), 40, 100);

  // 多取一条就够判断还有没有下一页，省一次 count(*)
  const rows = await env.DB
    .prepare(
      'SELECT id, created_at, name, color, body, status, reply_body, reply_at ' +
      "FROM notes WHERE status = 'visible' ORDER BY id DESC LIMIT ?"
    )
    .bind(limit + 1)
    .all();

  const list = rows.results || [];
  const more = list.length > limit;
  const notes = (more ? list.slice(0, limit) : list).map((r) => toNote(r));

  return json(request, 200, { notes, more });
}

export async function onRequestPost({ request, env }) {
  const body = await readJson(request);

  // 蜜罐：前端那个藏起来的 hp 字段，只有机器人会填
  if (cleanText(body.hp, 64)) {
    return fail(request, 400, '不好意思，这一张没贴上去。');
  }

  // 打开表单到点提交的间隔，人不可能 1.5 秒内写完
  const t0 = Number(body.t0);
  if (!Number.isFinite(t0) || Date.now() - t0 < MIN_ELAPSED_MS) {
    return fail(request, 400, '你贴得太快了，再确认一下内容。');
  }

  const text = cleanText(body.body, BODY_MAX + 200);
  if (!text) return fail(request, 400, '便签是空的。');
  if (text.length > BODY_MAX) return fail(request, 400, `太长了，最多 ${BODY_MAX} 字。`);

  const name = cleanText(body.name, NAME_MAX);
  const color = normalizeColor(body.color);
  const token = cleanText(body.token, 200);

  const ipHash = await ipHashOf(request, env);

  const over = await checkRate(env.DB, ipHash);
  if (over) return fail(request, 429, over);

  const at = nowCN();
  const tokenHash = await sha256Hex(token);

  // token_hash 空串表示「这张没带 token」，之后就没法自删了
  const res = await env.DB
    .prepare(
      'INSERT INTO notes (created_at, name, color, body, ip_hash, status, reply_body, reply_at, token_hash) ' +
      "VALUES (?, ?, ?, ?, ?, 'visible', '', '', ?)"
    )
    .bind(at, name, color, text, ipHash, tokenHash)
    .run();

  await bumpRate(env.DB, ipHash);

  const id = res.meta && res.meta.last_row_id != null ? res.meta.last_row_id : null;

  return json(request, 201, {
    ok: true,
    note: { id, name, color, body: text, at, reply: null }
  });
}

export async function onRequestDelete({ request, env }) {
  const body = await readJson(request);

  const id = parseInt(body.id, 10);
  if (!Number.isFinite(id)) return fail(request, 400, '没找到这张便签。');

  const token = cleanText(body.token, 200);
  if (!token) return fail(request, 400, '这张便签不是你贴的，撤不下来。');

  const row = await env.DB
    .prepare('SELECT id, status, token_hash FROM notes WHERE id = ?')
    .bind(id)
    .first();
  if (!row) return fail(request, 404, '没找到这张便签。');
  if (row.status === 'hidden') return fail(request, 400, '这张便签已经不在板子上了。');
  if (!row.token_hash) return fail(request, 400, '这张便签不是你贴的，撤不下来。');

  const tokenHash = await sha256Hex(token);
  if (tokenHash !== row.token_hash) return fail(request, 400, '这张便签不是你贴的，撤不下来。');

  // 软删：留痕，站长随时能在 admin/list 里看回来
  await env.DB.prepare("UPDATE notes SET status = 'hidden' WHERE id = ?").bind(id).run();

  return json(request, 200, { ok: true });
}
