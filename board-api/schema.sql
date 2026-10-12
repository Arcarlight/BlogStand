-- ============================================================
-- board-api / schema.sql  —— 布告栏 D1 表结构
-- ------------------------------------------------------------
-- 建表（本地）：
--   wrangler d1 execute board --local --file=schema.sql
-- 建表（线上，先建库拿到 database_id 写进 wrangler.toml）：
--   wrangler d1 execute board --remote --file=schema.sql
--
-- 「隐藏」是软删：status='hidden' 的行永远留着，
-- 公开列表只查 status='visible'，站长用 admin/list?status=all 看得到。
-- 原始 IP 一律不落库，只存 ip_hash / token_hash。
-- ============================================================

CREATE TABLE IF NOT EXISTS notes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT    NOT NULL DEFAULT '',          -- 北京时间 ISO 串：YYYY-MM-DDTHH:MM:SS+08:00
  name       TEXT    NOT NULL DEFAULT '',
  color      TEXT    NOT NULL DEFAULT 'white',
  body       TEXT    NOT NULL DEFAULT '',
  ip_hash    TEXT    NOT NULL DEFAULT '',          -- sha256(ip + salt) 前 16 位十六进制
  status     TEXT    NOT NULL DEFAULT 'visible',   -- 'visible' | 'hidden'
  reply_body TEXT    NOT NULL DEFAULT '',
  reply_at   TEXT    NOT NULL DEFAULT '',
  token_hash TEXT    NOT NULL DEFAULT ''           -- sha256(客户端 token) 全 64 位十六进制
);

-- 限流计数：一个 ip_hash 在某个时间桶里发了几条。
-- bucket 形如 'h:2026-10-13T20'（小时桶）/ 'd:2026-10-13'（天桶）。
CREATE TABLE IF NOT EXISTS rate (
  ip_hash TEXT    NOT NULL,
  bucket  TEXT    NOT NULL,
  n       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ip_hash, bucket)
);

-- 公开列表就是「按 status 过滤 + id 倒序 + limit」，这条索引直接覆盖
CREATE INDEX IF NOT EXISTS idx_notes_status_id ON notes (status, id DESC);
