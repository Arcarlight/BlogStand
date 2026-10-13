/* ============================================================
   /api/admin/delete —— **真删**一张便签（不是软删）
   ------------------------------------------------------------
     POST  头：x-board-token: <ADMIN_TOKEN>
           体：{"id":1}

   和 hide 的区别（站长的原话：「怎么只能隐藏不能删除啊」）：
     hide   -> status='hidden'，行留着，数据和回复都在，随时能恢复
     delete -> DELETE FROM notes WHERE id = ?，**这一行就没了，不可恢复**

   只用管理员令牌（x-board-token），和 hide / reply 同一道门。
   删之前前端会让站长确认一次 —— 这条是真的回不来了。
   ============================================================ */

import { fail, isAdmin, json, noteById, preflight, readJson, unauthorized } from '../_shared.js';

export async function onRequestOptions({ request }) {
  return preflight(request);
}

export async function onRequestPost({ request, env }) {
  if (!isAdmin(request, env)) return unauthorized(request);

  const payload = await readJson(request);

  const id = parseInt(payload.id, 10);
  if (!Number.isFinite(id)) return fail(request, 400, 'id 不对。');

  const row = await noteById(env.DB, id);
  if (!row) return fail(request, 404, '没找到这张便签（可能已经被删掉了）。');

  await env.DB.prepare('DELETE FROM notes WHERE id = ?').bind(id).run();

  return json(request, 200, { ok: true, id: id, deleted: true });
}
