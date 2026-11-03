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

-- ============================================================
-- 访客计数（自建，替代不蒜子）
-- ------------------------------------------------------------
-- 之前用 busuanzi.ibruce.info，但它的接口经常 502 抽风（2026-11-03 实测
-- 90 秒里 4 次 502），而且第三方什么时候停服谁也说不准。这两个表把数字
-- 拿回自己手里：
--   hits     —— 每个路径的浏览次数（PV）
--   visitors —— 去重后的访客（UV），只存 sha256(浏览器随机 id + salt) 的前 16 位
-- 原始 IP、原始浏览器 id 都不落库。
-- ============================================================

CREATE TABLE IF NOT EXISTS hits (
  path       TEXT    NOT NULL PRIMARY KEY,   -- '/blog/xxx/'（统一带尾斜杠）
  pv         INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT    NOT NULL DEFAULT ''     -- 北京时间 ISO 串
);

CREATE TABLE IF NOT EXISTS visitors (
  vid TEXT NOT NULL PRIMARY KEY,             -- sha256(访客随机 id + salt) 前 16 位
  at  TEXT NOT NULL DEFAULT ''               -- 第一次出现（北京时间）
);

-- 历史基准：从 不蒜子 迁过来的旧数据。
-- site_uv 没法还原成一个个访客（不蒜子只给总数），所以存成基准值，
-- 页面上 = 基准 + 之后新访客去重计数；site_pv 同理（剩下的部分）。
CREATE TABLE IF NOT EXISTS baseline (
  key   TEXT    NOT NULL PRIMARY KEY,   -- 'site_uv' | 'site_pv'
  value INTEGER NOT NULL DEFAULT 0
);
