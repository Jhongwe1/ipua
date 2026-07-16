-- Migration 0003 — v2.0.0 Phase I：每日用量聚合表。
-- 由 cron（src/cron.ts rollupUsageDaily）每日結算「昨日」的 req_log 寫入；
-- INSERT OR REPLACE ＋ 複合主鍵 → 同日重跑冪等。req_log 本身 90 天輪替（cron purge），
-- 這張表永久保留 → 長期用量／成本報告（docs/REPORT.md）的數據源。
CREATE TABLE IF NOT EXISTS usage_daily (
  day        TEXT NOT NULL,              -- 'YYYY-MM-DD'（UTC）
  user_id    INTEGER NOT NULL,
  svc        TEXT NOT NULL,              -- 'relay' 或 'pg'
  channel    TEXT NOT NULL DEFAULT '',
  model      TEXT NOT NULL DEFAULT '',
  n          INTEGER NOT NULL DEFAULT 0, -- 請求數
  errs       INTEGER NOT NULL DEFAULT 0, -- 其中失敗數（status>=400 或 0）
  tokens_in  INTEGER,                    -- SUM(tokens_in)（全 NULL＝NULL）
  tokens_out INTEGER,
  dur_ms_sum INTEGER,                    -- SUM(dur_ms)（除以 n＝平均耗時）
  PRIMARY KEY (day, user_id, svc, channel, model)
);
CREATE INDEX IF NOT EXISTS idx_usage_daily_user ON usage_daily (user_id, day);
