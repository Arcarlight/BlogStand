/* ============================================================
   /api/build —— 查 GitHub Actions 构建状态（契约 §4）
   GET -> {ok:true, status, conclusion, htmlUrl, headSha, createdAt, runNumber}
   没有运行记录 -> {ok:true, status:null}
   ============================================================ */

import { ghConfig, ghJson, json } from './_shared.js';

export async function onRequestGet({ env }) {
  const cfg = ghConfig(env);
  const data = await ghJson(
    env,
    `/repos/${cfg.repo}/actions/runs?branch=${encodeURIComponent(cfg.branch)}&per_page=1`
  );
  const runs = (data && data.workflow_runs) || [];
  const run = runs[0];
  if (!run) return json({ ok: true, status: null });
  return json({
    ok: true,
    status: run.status == null ? null : run.status,
    conclusion: run.conclusion == null ? null : run.conclusion,
    htmlUrl: run.html_url || '',
    headSha: run.head_sha || '',
    createdAt: run.created_at || '',
    runNumber: run.run_number == null ? null : run.run_number,
  });
}
