# DEBT.md — 已知債務與門檻（誠實帳本）

> 每筆債都寫「是什麼、為何先欠著、什麼時候該還」。發現新債往下加，還掉就劃線留紀錄。

| # | 債 | 為何先欠 | 還債門檻 |
|---|---|---|---|
| 1 | **圖片存 D1 BLOB 而非 R2** | 單一資料庫的運維簡單值回票價（ADR-0002）；目前圖量小 | media 總量近 1 GB，或單月圖片流量明顯拖慢 D1 匯出／備份 |
| 2 | ~~**pg_messages 無保留策略**~~ ✅ v2.0.0 Phase I 還清：每日 cron 清 360 天前訊息（src/cron.ts purgeOld） | 對話是會員資產，不敢亂刪；量還小 | ~~表破 10 萬列：加「會員可刪」之外的過期歸檔（例：360 天）~~ |
| 3 | **BYOK（會員自帶上游金鑰）未做** | 拍板 v1 用共享金鑰＋配額（ADR-0003） | 有會員的正當用量超過管理員願意墊的錢 |
| 4 | ~~**告警只有站內（errlog／logs 頁）**~~ ✅ v2.0.0 Phase I 還清：每 5 分鐘 cron 掃 errlog 推 Telegram（secrets 未設＝自動停用） | 拍板 v1 不接 Telegram/Sentry；個人站可接受人工巡 | ~~出現「錯誤發生 >1 天才被看到」的實際案例~~ |
| 5 | ~~**無 eslint／prettier**~~ ✅ v2.0.0 Phase E 還清：ESLint flat config＋typescript-eslint＋Prettier＋CI lint job | tsc（@ts-check 新模組）＋測試已擋住大半；風格靠人肉一致 | ~~出現第二位貢獻者~~ |
| 6 | ~~**req_log 不做 usage_daily 聚合表**~~ ✅ v2.0.0 Phase I 還清：migration 0003＋每日 cron 結算（冪等），長期報告數據源 | 流量小，COUNT 走 (user_id,svc,ts) 索引足夠 | ~~req_log 破 50 萬列或 /logs 用量分頁明顯變慢~~ |
| 7 | **custom 渠道不加 stream_options.include_usage** | 自架/本地服務可能拒收未知欄位 | OpenAI 相容自架服務普遍支援後，改成 per-channel 開關 |
| 8 | **舊 LOGS_TOKEN 仍在 git 歷史** | 私有 repo＋發佈時已輪替新值，風險受控 | **repo 公開前必須 `git filter-repo` 洗歷史**（硬性門檻） |
| 9 | **CSP style-src 保留 'unsafe-inline'** | 全站大量 inline style，改造工程大、收益小（ADR-0004） | 若要拿 CSP 滿分（如安全掃描需求）：抽出共用 <style> 或加 style nonce |
| 10 | ~~**配額算「次數」不算「錢」**~~ ✅ v2.0.0 Phase J 半清：model_prices 定價表＋stats／/logs 估算成本（回溯計價，報告用）；**配額執法仍算次數（維持拍板，不算還債缺口）** | 各家計價表是維護負擔；token 數已入庫，之後可回溯計價 | ~~單月上游帳單失控，或想出成本報告時~~ |
| 11 | ~~**D1 無自動備份**~~ ✅ v2.0.0 Phase I 還清：每日 cron 全庫 JSONL 進 R2（BLOB 排除、保留 14 份）；手動 export 指令仍在 ADMIN.md 當第二保險 | 個人站接受手動 `wrangler d1 export`（ADMIN.md 有指令） | ~~內容量大到「重寫一遍會心痛」：加 GitHub Actions 定期 export~~ |
| 12 | **vitest-pool-workers 鎖 wrangler ~4.44** | pool-workers 0.9 的相容組合（Phase A 實測 4.110 撞版） | pool-workers 出新版支援新 wrangler 時一起升 |
