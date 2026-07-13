-- 2026-07-13 升級 migration：分服務批准＋渠道模型名稱＋LLM Playground。
-- 給「已經跑過舊版 schema.sql」的資料庫補欄位用；全新資料庫直接跑 schema.sql 即可、不用這份。
-- 注意：ALTER TABLE 重複執行會報 duplicate column，這份只能跑一次（新表由 schema.sql 的 IF NOT EXISTS 建）。
--   本機：npx wrangler d1 execute ipua-logs --local  --file db/migrate-2026-07-13.sql
--   正式：npx wrangler d1 execute ipua-logs --remote --file db/migrate-2026-07-13.sql -y
ALTER TABLE users ADD COLUMN services TEXT NOT NULL DEFAULT '';
ALTER TABLE relay_channels ADD COLUMN models TEXT NOT NULL DEFAULT '';

-- 過渡規則（站長 2026-07-13 拍板）：升級當下已批准的會員，三個服務全部自動帶入。
UPDATE users SET services='relay,vpn,playground' WHERE status='approved';

-- 既有的 gemini 渠道補上模型名稱（站長指定）。
UPDATE relay_channels SET models='gemini-3.1-flash-lite' WHERE slug='gemini';
