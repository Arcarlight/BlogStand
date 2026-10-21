/* ============================================================
   /api/logout —— 清 cookie
   POST {} -> {ok:true} + Set-Cookie: be_sess=; Max-Age=0
   ============================================================ */

import { json, sessionCookieHeader } from './_shared.js';

export async function onRequestPost() {
  return json({ ok: true }, 200, {
    'Set-Cookie': sessionCookieHeader('', 0),
  });
}
