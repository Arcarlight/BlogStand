/* ============================================================
   /api/admin/reply —— 站长回一张便签
   ------------------------------------------------------------
     POST  头：x-board-token: <ADMIN_TOKEN>
           体：{"id":1,"body":"…"}      body ≤ 500 字

   回复的落款固定是「虹星」（前端也是这么显示的），
   所以这里不存 by，只存 reply_body / reply_at。
   ============================================================ */

import { REPLY_MAX, cleanText, fail, isAdmin, json, noteById, nowCN, preflight, readJson, toNote, unauthorized } from '../_shared.js';

export async function onRequestOptions({ request }) {
  return preflight(request);
}

export async function onRequestPost({ request, env }) {
  if (!isAdmin(request, env)) return unauthorized(request);

  const payload = await readJson(request);

  const id = parseInt(payload.id, 10);
  if (!Number.isFinite(id)) return fail(request, 400, 'id 不对。');

  const text = cleanText(payload.body, REPLY_MAX + 200);
  if (!text) return fail(request, 400, '回复不能是空的。');
  if (text.length > REPLY_MAX) return fail(request, 400, `回复太长了，最多 ${REPLY_MAX} 字。`);

  const row = await noteById(env.DB, id);
  if (!row) return fail(request, 404, '没找到这张便签。');

  const at = nowCN();
  await env.DB
    .prepare('UPDATE notes SET reply_body = ?, reply_at = ? WHERE id = ?')
    .bind(text, at, id)
    .run();

  const fresh = await noteById(env.DB, id);
  return json(request, 200, { ok: true, note: toNote(fresh, true) });
}
