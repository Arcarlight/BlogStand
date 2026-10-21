/* ============================================================
   /api/session —— 前端用来判断 cookie 还有没有效
   GET -> {authed:true, repo, branch}
   （能走到这里说明中间件已经鉴权通过）
   ============================================================ */

import { json } from './_shared.js';

export async function onRequestGet({ env }) {
  return json({
    authed: true,
    repo: (env && env.GITHUB_REPO) || 'Arcarlight/BlogStand',
    branch: (env && env.GITHUB_BRANCH) || 'main',
  });
}
