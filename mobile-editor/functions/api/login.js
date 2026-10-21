/* ============================================================
   /api/login —— 口令换签名 cookie（契约 §1）
   POST {pass} -> {ok:true, exp} + Set-Cookie: be_sess
   失败 401 {error:"口令不对"}

   限流：同一 IP 10 分钟内最多 8 次失败，超了 429。
   ⚠ Map 是模块级（isolate 内存），只是尽力而为：冷启动会重置，
     多 isolate 各算各的。真要严格限流得上 KV/D1，这里按契约用内存版。
   ============================================================ */

import {
  SESSION_MAX_AGE,
  createSessionValue,
  json,
  readJsonBody,
  sessionCookieHeader,
  verifyEditorPass,
} from './_shared.js';

const WINDOW_MS = 10 * 60 * 1000;
const MAX_FAILS = 8;

/** ip -> number[]（失败时间戳） */
const failLog = new Map();

function clientIp(request) {
  return (
    request.headers.get('CF-Connecting-IP') ||
    (request.headers.get('X-Forwarded-For') || '').split(',')[0].trim() ||
    request.headers.get('X-Real-IP') ||
    '0.0.0.0'
  );
}

function prune(list, now) {
  while (list.length && now - list[0] > WINDOW_MS) list.shift();
  return list;
}

export async function onRequestPost({ request, env }) {
  if (!env.EDITOR_PASS || !env.SESSION_SECRET) {
    return json({ error: '服务端还没配置 EDITOR_PASS / SESSION_SECRET' }, 500);
  }

  const ip = clientIp(request);
  const now = Date.now();
  const fails = prune(failLog.get(ip) || [], now);
  failLog.set(ip, fails);
  if (fails.length >= MAX_FAILS) {
    return json({ error: '尝试次数太多，10 分钟后再试' }, 429);
  }

  const body = await readJsonBody(request, 64 * 1024);
  const pass = body.pass == null ? '' : String(body.pass);

  if (!(await verifyEditorPass(env, pass))) {
    fails.push(now);
    return json({ error: '口令不对' }, 401);
  }

  // 成功就清掉这个 IP 的失败记录
  failLog.delete(ip);

  const value = await createSessionValue(env);
  const exp = value.slice(0, value.indexOf('.'));
  return json({ ok: true, exp }, 200, {
    'Set-Cookie': sessionCookieHeader(value, SESSION_MAX_AGE),
  });
}
