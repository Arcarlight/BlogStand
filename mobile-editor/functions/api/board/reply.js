/* ============================================================
   /api/board/reply —— 站长回复（契约 §4）
   POST {id, body} -> 转发到布告栏后端 /api/admin/reply，原样返回
   ============================================================ */

import { boardAdminFetch, json, readJsonBody } from '../_shared.js';

export async function onRequestPost({ request, env }) {
  const body = await readJsonBody(request, 64 * 1024);
  const { status, data } = await boardAdminFetch(env, '/api/admin/reply', {
    method: 'POST',
    body: JSON.stringify({ id: body.id, body: body.body }),
  });
  return json(data, status);
}
