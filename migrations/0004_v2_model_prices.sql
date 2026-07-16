-- Migration 0004 — v2.0.0 Phase J：模型定價表（成本記帳）。
-- 管理員用 PUT /api/admin/prices 整包維護；req_log 已存 tokens_in/out，成本＝事後 JS 端
-- 對照（精確名 > 最長前綴，src/lib/cost.ts pickPrice）— 定價改了歷史成本跟著重算，
-- 這是「估算值」的刻意設計（ADR-0003 配額算次數；錢的部分只作報告，不作執法）。
CREATE TABLE IF NOT EXISTS model_prices (
  pattern          TEXT NOT NULL UNIQUE, -- 模型名；尾端 '*' ＝前綴匹配（例 gpt-4o*）
  input_usd_per_m  REAL NOT NULL DEFAULT 0, -- 每百萬 input tokens 美元
  output_usd_per_m REAL NOT NULL DEFAULT 0,
  note             TEXT NOT NULL DEFAULT '',
  updated_at       TEXT NOT NULL
);
