-- Migration 0005 — v2.1.0：管道層的 LLM Playground 系統提示詞。
-- 只作用在 playground（src/lib/playground.ts buildUpstream 注入）。/relay API 中轉走的是
-- src/routes/relay/[[path]].ts 原樣轉發，完全不讀這一欄 — 會員拿自己的 uak- 金鑰打中轉時
-- 行為一個字都不變。這是刻意的：中轉要保持「透明代理」，會員送什麼就轉什麼，
-- 偷偷塞系統提示詞會讓中轉的行為跟上游原廠不一致，也會破壞會員自己的 system 設定。
-- 空字串＝不注入（預設）。三種上游各自的擺法在 buildUpstream：
--   anthropic → system 欄位／gemini → systemInstruction／openai 相容 → messages 最前面一則 system。
ALTER TABLE relay_channels ADD COLUMN system_prompt TEXT NOT NULL DEFAULT '';
