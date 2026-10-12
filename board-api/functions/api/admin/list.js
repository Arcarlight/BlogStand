/* ============================================================
   /api/admin/list —— 站长看全部（含隐藏）
   ------------------------------------------------------------
     GET   头：x-board-token: <ADMIN_TOKEN>
           ?status=all|visible|hidden   默认 all
           ?limit=200                   默认 200，上限 500

   比公开版多一个字段：status。
   ip_hash / token_hash 依然不出去。
   ============================================================ */

import { clampLimit, isAdmin, json, preflight, toNote, unauthorized } from '../_shared.js';

const STATUSES = ['all', 'visible', 'hidden'];

export async function onRequestOptions({ request }) {
  return preflight(request);
}

export async function onRequestGet({ request, env }) {
  if (!isAdmin(request, env)) return unauthorized(request);

  const url = new URL(request.url);
  const want = url.searchParams.get('status') || 'all';
  const status = STATUSES.includes(want) ? want : 'all';
  const limit = clampLimit(url.searchParams.get('limit'), 200, 500);

  const cols = 'SELECT id, created_at, name, color, body, status, reply_body, reply_at FROM notes ';
  const stmt = status === 'all'
    ? env.DB.prepare(cols + 'ORDER BY id DESC LIMIT ?').bind(limit)
    : env.DB.prepare(cols + 'WHERE status = ? ORDER BY id DESC LIMIT ?').bind(status, limit);

  const rows = await stmt.all();
  const notes = (rows.results || []).map((r) => toNote(r, true));

  return json(request, 200, { ok: true, status, notes });
}
