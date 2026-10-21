/* ============================================================
   /api/board/delete —— 真删（契约 §4）
   POST {id} -> 转发到 /api/admin/delete，原样返回
   ============================================================ */

import { boardAdminFetch, json, readJsonBody } from '../_shared.js';

export async function onRequestPost({ request, env }) {
  const body = await readJsonBody(request, 64 * 1024);
  const { status, data } = await boardAdminFetch(env, '/api/admin/delete', {
    method: 'POST',
    body: JSON.stringify({ id: body.id }),
  });
  return json(data, status);
}
