-- Migration 0006 — v2.1.0：管道的「額外請求參數」（JSON 物件字串）。
-- 合併進 playground 送給上游的請求本體，用來處理各家的專屬參數。
-- 起因（2026-07-20 實測）：Venice 會在我們的系統提示詞「後面」再注入一大段他們自己的，
-- 內含「You are running on Venice.ai」與身分覆寫，直接壓過我們設定的人設 —
-- 要靠 {"venice_parameters":{"include_venice_system_prompt":false}} 才關得掉。
-- 與其為單一供應商寫死，不如開一個通用欄位：以後 OpenAI 的 reasoning_effort、
-- Anthropic 的 thinking、各家的怪癖都能直接填，不用再改一次程式。
-- 一樣只作用在 /playground；/relay 中轉是透明代理，一律不注入（見 migration 0005 的同款說明）。
-- 空字串＝不合併。存檔時驗過必須是合法 JSON 物件（見 cleanChannel）。
ALTER TABLE relay_channels ADD COLUMN extra_body TEXT NOT NULL DEFAULT '';
