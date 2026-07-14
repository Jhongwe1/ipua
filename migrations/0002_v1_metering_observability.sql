-- Migration 0002 — v1.0.0 計量與可觀測性（Phase C/D/E 共用，一次到位、remote 只跑一步）。
-- 純增量：只建新表、users 加新欄（NULL 預設）；舊程式完全無視這些表欄，前向相容。

-- 每次計費請求一列（relay 轉發＋playground 聊天）：
-- 配額計數（COUNT 走 (user_id,svc,ts) 索引）與延遲/成本研究數據共用一張表。
-- 流量小，不做 usage_daily 聚合（門檻記在 DEBT.md）。
CREATE TABLE IF NOT EXISTS req_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         TEXT NOT NULL,             -- UTC ISO
  user_id    INTEGER NOT NULL,
  svc        TEXT NOT NULL,             -- 'relay' 或 'pg'
  channel    TEXT NOT NULL DEFAULT '',  -- 渠道 slug
  model      TEXT NOT NULL DEFAULT '',  -- 從「回應」掃出的模型名（絕不緩衝會員請求）
  status     INTEGER NOT NULL DEFAULT 0,-- 上游 HTTP 狀態；0=連不上
  dur_ms     INTEGER,                   -- 全程耗時
  ttfb_ms    INTEGER,                   -- 上游首位元組延遲
  tokens_in  INTEGER,                   -- 上游回報的 input tokens（掃不到＝NULL）
  tokens_out INTEGER
);
CREATE INDEX IF NOT EXISTS idx_reqlog_user ON req_log (user_id, svc, ts);
CREATE INDEX IF NOT EXISTS idx_reqlog_ts ON req_log (ts);

-- 站內錯誤日誌（拍板：先只做站內，無 Telegram/Sentry）：/logs 錯誤分頁讀這張表。
CREATE TABLE IF NOT EXISTS errlog (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      TEXT NOT NULL,
  src     TEXT NOT NULL,               -- 出錯位置代號：relay.upstream / pg.stream / oauth.callback / csp …
  msg     TEXT NOT NULL DEFAULT '',    -- 錯誤訊息（截 500 字）
  detail  TEXT NOT NULL DEFAULT '',    -- 補充細節（截 2000 字）
  user_id INTEGER,                     -- 有身分時記下（除錯用）
  path    TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_errlog_ts ON errlog (ts);

-- 管理操作稽核（誰、何時、對誰、做了什麼）：所有 admin 變更端點都寫一列。
-- summary 絕不含秘密（渠道金鑰只記「有無更新」）。
CREATE TABLE IF NOT EXISTS audit_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      TEXT NOT NULL,
  actor   TEXT NOT NULL DEFAULT '',    -- 操作者 email；用管理金鑰時是 'token'
  action  TEXT NOT NULL,               -- 例：users.set_services / settings.put / relay.channel.create
  target  TEXT NOT NULL DEFAULT '',    -- 對象（user id、channel slug…）
  summary TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log (ts);

-- 個人配額覆寫（NULL＝用 settings 的全域預設；站長完全豁免不看這些）：
ALTER TABLE users ADD COLUMN quota_relay_day INTEGER;  -- relay 每日請求數上限
ALTER TABLE users ADD COLUMN quota_pg_day INTEGER;     -- playground 每日訊息數上限
ALTER TABLE users ADD COLUMN rl_per_min INTEGER;       -- 兩服務共用的每分鐘上限
