/* ============================================================
   /api/admin/hide —— 把一张便签盖起来 / 放回去
   ------------------------------------------------------------
     POST  头：x-board-token: <ADMIN_TOKEN>
           体：{"id":1,"hidden":true|false}

   hidden:true -> status='hidden'（公开列表看不到）
   hidden:false -> status='visible'
   ============================================================ */

import { fail, isAdmin, json, noteById, preflight, readJson, toNote, unauthorized } from '../_shared.js';

export async function onRequestOptions({ request }) {
  return preflight(request);
}

export async function onRequestPost({ request, env }) {
  if (!isAdmin(request, env)) return unauthorized(request);

  const payload = await readJson(request);

  const id = parseInt(payload.id, 10);
  if (!Number.isFinite(id)) return fail(request, 400, 'id 不对。');

  // 不给 hidden 就按「盖起来」处理
  const hidden = payload.hidden === undefined ? true : !!payload.hidden;
  const status = hidden ? 'hidden' : 'visible';

  const row = await noteById(env.DB, id);
  if (!row) return fail(request, 404, '没找到这张便签。');

  await env.DB.prepare('UPDATE notes SET status = ? WHERE id = ?').bind(status, id).run();

  const fresh = await noteById(env.DB, id);
  return json(request, 200, { ok: true, note: toNote(fresh, true) });
}
