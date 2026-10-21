/* ============================================================
   /api/board/hide —— 隐藏 / 恢复（契约 §4）
   POST {id, hidden:true|false} -> 转发到 /api/admin/hide，原样返回
   ============================================================ */

import { boardAdminFetch, json, readJsonBody } from '../_shared.js';

export async function onRequestPost({ request, env }) {
  const body = await readJsonBody(request, 64 * 1024);
  const payload = { id: body.id };
  if (body.hidden !== undefined) payload.hidden = !!body.hidden;
  const { status, data } = await boardAdminFetch(env, '/api/admin/hide', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  return json(data, status);
}
