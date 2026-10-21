/* ============================================================
   mobile-editor / functions/_middleware.js
   ------------------------------------------------------------
   所有请求都会经过这里（包括静态文件）。

   职责（契约 §1）：
     1. 静态文件：只补 X-Robots-Tag: noindex，其余透传
     2. /api/**：统一补 no-store / noindex
        - 公共路径白名单：/api/ping、/api/login
        - 其余一律校验 cookie be_sess（HMAC 签名 + 常量时间比较）
        - 未登录 401 {error:"unauthorized"}
        - 写请求（POST/PUT/DELETE/PATCH）要求 x-editor: 1，缺了 400
     3. EDITOR_PASS / SESSION_SECRET 没配置：除 ping 外的 /api 一律 500
        （ping 是部署自检用的，永远可用）
     4. 路由里抛出的 HttpError / 异常在这里统一转成 JSON
   ============================================================ */

import { errorToResponse, json, verifySession } from './api/_shared.js';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const CONFIG_ERROR = '服务端还没配置 EDITOR_PASS / SESSION_SECRET';

/** 去掉末尾斜杠，/api/login/ 也按 /api/login 处理 */
function normalizePath(pathname) {
  if (!pathname || pathname === '/') return '/';
  const p = pathname.replace(/\/+$/, '');
  return p || '/';
}

function isApiPath(pathname) {
  return pathname === '/api' || pathname.startsWith('/api/');
}

/** 给响应补上契约要求的头（不覆盖路由已经设置的） */
function finalizeResponse(res, isApi) {
  const headers = new Headers(res.headers);
  headers.set('x-robots-tag', 'noindex');
  if (isApi && !headers.has('cache-control')) headers.set('cache-control', 'no-store');
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

export async function onRequest(context) {
  const { request, env, next } = context;
  let url;
  try {
    url = new URL(request.url);
  } catch (e) {
    return json({ error: '请求地址不对' }, 400);
  }
  const pathname = url.pathname;
  const isApi = isApiPath(pathname);
  const norm = normalizePath(pathname);

  try {
    /* ---------- 静态文件：透传，只加 noindex ---------- */
    if (!isApi) {
      return finalizeResponse(await next(), false);
    }

    /* ---------- ping：不需要配置，也不需要登录 ---------- */
    if (norm === '/api/ping') {
      return finalizeResponse(await next(), true);
    }

    /* ---------- 配置缺失：登录和其它接口都没法工作 ---------- */
    if (!env.EDITOR_PASS || !env.SESSION_SECRET) {
      return json({ error: CONFIG_ERROR }, 500);
    }

    /* ---------- 登录：公共路径，但写请求仍要 x-editor ---------- */
    if (norm === '/api/login') {
      if (WRITE_METHODS.has(request.method) && request.headers.get('x-editor') !== '1') {
        return json({ error: 'missing x-editor header' }, 400);
      }
      return finalizeResponse(await next(), true);
    }

    /* ---------- 其它 /api：先鉴权 ---------- */
    const authed = await verifySession(request, env);
    if (!authed) return json({ error: 'unauthorized' }, 401);

    /* ---------- CSRF 护栏：写请求必须带 x-editor: 1 ---------- */
    if (WRITE_METHODS.has(request.method) && request.headers.get('x-editor') !== '1') {
      return json({ error: 'missing x-editor header' }, 400);
    }

    return finalizeResponse(await next(), true);
  } catch (e) {
    return errorToResponse(e);
  }
}
