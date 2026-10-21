/* ============================================================
   /api/ping —— 公共健康检查（不需要登录）
   GET -> {ok:true, app, version, time}
   ============================================================ */

import { json } from './_shared.js';

export async function onRequestGet() {
  return json({
    ok: true,
    app: 'blogstand-mobile',
    version: '0.1.0',
    time: new Date().toISOString(),
  });
}
