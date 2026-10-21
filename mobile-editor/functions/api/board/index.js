/* ============================================================
   /api/board —— 布告栏列表（契约 §4）
   GET ?status=all|visible|hidden
   带 x-board-token 转发到 env.BOARD_API 的 /api/admin/list，
   布告栏后端原样返回 {ok:true, status, notes:[...]}。token 不外泄。
   ============================================================ */

import { boardAdminFetch, json } from '../_shared.js';

const STATUSES = new Set(['all', 'visible', 'hidden']);

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const want = (url.searchParams.get('status') || 'all').trim();
  const status = STATUSES.has(want) ? want : 'all';

  const { status: code, data } = await boardAdminFetch(
    env,
    `/api/admin/list?status=${encodeURIComponent(status)}`
  );
  return json(data, code);
}
