---
name: uaip-api
description: 操作 uaip.cc.cd 網站 — 發佈新聞/文章、上傳圖片、開自訂頁面（新連結 /p/slug）、改側邊欄選單、改站名、查訪客紀錄。凡是要「在網站上」新增或修改內容時使用（不是改程式碼時）。
---

# uaip.cc.cd 網站操作

**先讀專案根目錄這兩份文件再動手**（本 skill 只是入口，內容以它們為準）：

1. **AGENTS.md** — 操作指南：金鑰在哪、常用流程（發文/開頁面/掛選單/查流量）可直接照抄、做完怎麼驗證。
2. **API.md** — 完整 API 文件：所有端點、參數與欄位規則、錯誤代碼。

管理金鑰在 **ADMIN.md** 的「管理金鑰（LOGS_TOKEN）」段落。

## 三條鐵則（沒讀完文件前也要遵守）

1. **PUT 一律整包覆蓋**（文章、頁面、選單）：先 GET 現況 → 只改要改的欄位 → 整包 PUT。漏帶的欄位會被清空。
2. **圖片編號（/img/{id}）永遠不能重複使用**：一年 immutable 快取且清不掉。換圖＝新編號＋更新引用；絕不重設 media 流水號。
3. **中文必走 UTF-8 檔案**：`curl --data-binary @檔案`；中文寫在 Windows 指令列會亂碼。

改到程式碼（而非內容）時：改了 API 要同步 `API.md` 並跑 `node tools/build-apidoc.mjs`
（`lib/apidoc.js` 是自動產生的，不要手改）；部署 `npx wrangler pages deploy`（不加參數）。
