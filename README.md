# uaip — IP／UA 查詢站 ＋ 新聞／文章網站

線上網址：<https://uaip.cc.cd>（架在 **Cloudflare Pages**）

這是一個個人網站，包含三大功能：

1. **工具**：查詢訪客自己的 IP／User-Agent 等連線資訊（首頁 `/`、`/ip`、`/ua`）。
2. **內容**：新聞／文章系統（後台發文、圖片存資料庫、SSR 列表與文章頁、RSS、sitemap）。
3. **自訂頁面**：用 API 就能開新頁面（新連結），公開網址 `/p/網址代稱`，適合「關於本站」這類獨立頁。

站長專用（對一般訪客隱藏）：**文章管理**（/admin）、**訪客紀錄**（/logs）、
**✎ 編輯模式**（右上角，可直接在網頁上編輯文章、改側邊欄選單、改站名）、
**API 文件**（/api-docs，要金鑰才看得到內容）。這些管理頁與前台共用同一套版型
（☰ 側邊欄、日夜主題、中英切換）。

## 文件地圖（找東西先看這）

| 文件 | 內容 |
|---|---|
| [API.md](./API.md) | **完整 API 文件**：所有端點、參數、欄位規則、curl 範例（也是線上 /api-docs 的原稿） |
| [AGENTS.md](./AGENTS.md) | **給 AI agent 的操作指南**：金鑰在哪、發文/開頁面/掛選單的照抄流程、驗證清單 |
| [ADMIN.md](./ADMIN.md) | 站長維護筆記：**管理金鑰**、部署眉角、資料庫維護、廣告計畫（不會部署上網） |
| `.claude/skills/uaip-api/` | Claude Code 的 skill 入口（薄殼，內容指向 AGENTS.md 與 API.md） |

這份 README 只講「這是什麼、怎麼跑起來、API 快速上手」。

---

## 用 API 操作網站（快速上手）

全站功能（發文、開頁面、改選單、改站名、查流量）都有 API，不用進後台網頁。
站長 API 要帶 `Authorization: Bearer <管理金鑰>`（金鑰在 [ADMIN.md](./ADMIN.md)；本機 localhost 免金鑰）。

**發一篇新聞**（中文一定先存成 UTF-8 的 `art.json` 再送，直接寫在指令列會亂碼）：

```bash
# art.json： { "category":"news", "status":"published", "title":"標題",
#             "summary":"一兩句摘要", "cover":"/img/5", "body_md":"內文 **Markdown**" }
curl -X POST https://uaip.cc.cd/api/admin/articles \
  -H "Authorization: Bearer 管理金鑰" \
  -H "content-type: application/json; charset=utf-8" --data-binary @art.json
# 回 { "id":12, "status":"published" } → 上線在 /news/12
```

**開一個新頁面（新連結）**，例如「關於本站」：

```bash
# page.json： { "slug":"about", "status":"published", "title":"關於本站",
#              "summary":"SEO 描述", "body_md":"## 內容\n\n……" }
curl -X POST https://uaip.cc.cd/api/admin/pages \
  -H "Authorization: Bearer 管理金鑰" \
  -H "content-type: application/json; charset=utf-8" --data-binary @page.json
# 回 { "url":"/p/about" } → 上線在 https://uaip.cc.cd/p/about
```

**把新頁面掛進側邊欄**：`GET /api/menu` 拿現況 → items 加
`{ "kind":"link", "label":"關於本站", "url":"/p/about" }` → 整包 `PUT /api/admin/menu`。

其餘端點（圖片上傳、改站名、訪客紀錄、公開讀取…）與三條鐵則（PUT 整包覆蓋、
圖片編號不可重用、UTF-8）詳見 **[API.md](./API.md)**。

---

## 技術架構

| 項目 | 用什麼 |
|---|---|
| 主機 | Cloudflare Pages（免費方案） |
| 伺服端程式 | Pages Functions（`functions/` 資料夾，Node/Workers 語法） |
| 資料庫 | Cloudflare D1（SQLite），名稱 `ipua-logs`，綁定名 `DB` |
| 部署工具 | `wrangler`（用 `npx` 執行，免安裝） |
| 前端 | 純 HTML／CSS／JS，無框架；Markdown 用 `marked` |

**不用 `npm install`**：本專案沒有 `node_modules`，所有指令都用 `npx wrangler ...` 直接跑。

---

## 資料夾結構（簡版）

```
ipua/
├─ wrangler.toml     ← Pages 設定：專案名 uaip、輸出資料夾 public、D1 綁定
├─ README.md         ← 你正在看的這份
├─ API.md            ← 完整 API 文件（唯一原稿；線上 /api-docs 由它產生）
├─ AGENTS.md         ← 給 AI agent 的操作指南（流程照抄、驗證清單）
├─ ADMIN.md          ← 站長詳細筆記（含金鑰、維護指令、廣告計畫）
├─ .claude/skills/uaip-api/  ← Claude Code skill 入口（指向 AGENTS.md／API.md）
├─ tools/build-apidoc.mjs    ← 把 API.md 轉成 lib/apidoc.js（改完文件要跑）
├─ db/schema.sql     ← 資料表結構（visits 訪客／articles 文章／media 圖片／pages 自訂頁面／menu 選單／settings 設定）
├─ lib/              ← Functions 共用程式（site.js 外殼、pages.js 渲染、apidoc.js＝自動產生、vendor/marked）
├─ functions/        ← 伺服端程式（API、SSR 頁面、/logs 與 /admin 管理頁、訪客紀錄中介層）
└─ public/           ← 真正上網的靜態檔（只有這個資料夾會被部署）
   ├─ index.html     ← 主站（IP／UA 查詢工具）
   └─ assets/        ← 前端腳本（admin.js、logs.js、adminbar.js、marked.js）
```

完整檔案清單與每個檔案的作用，見 [ADMIN.md](./ADMIN.md) 開頭的結構圖。

---

## 部署上線

在專案資料夾裡執行（**指令不要加任何參數，尤其不要加「.」**）：

```bash
npx wrangler pages deploy
```

`wrangler.toml` 已寫好專案名與輸出資料夾，所以不用帶參數。
加了 `.` 會把根目錄（含筆記、快取）整包上傳，是錯的。
也**不能**用 Cloudflare 後台的拖曳上傳（那樣 Functions 與 D1 綁定會消失）。

第一次在新電腦部署，要先登入 Cloudflare：

```bash
npx wrangler login
```

若改過 `db/schema.sql`，正式資料庫要補跑一次（`IF NOT EXISTS`，跑幾次都安全）：

```bash
npx wrangler d1 execute ipua-logs --remote --file db/schema.sql
```

---

## 本機測試

```bash
# 第一次先建本機資料庫（跟正式站完全分開）
npx wrangler d1 execute ipua-logs --local --file db/schema.sql

# 啟動本機開發伺服器 → http://localhost:8788
npx wrangler pages dev
```

本機（localhost）後台與 API **免金鑰**，方便隨便試寫，不影響線上。

---

## 幾個一定要知道的重點

- **管理金鑰（LOGS_TOKEN）** 是 Cloudflare Pages 的加密環境變數，不是寫在程式碼裡。
  `/logs`、`/admin`、`/api-docs` 與所有站長 API 共用同一把。金鑰值與更換指令在 [ADMIN.md](./ADMIN.md)。
- **全站功能都有 API**：發文、上傳圖、開自訂頁面、改選單、改站名、查紀錄。
  文件唯一原稿是 **[API.md](./API.md)**；改完跑 `node tools/build-apidoc.mjs` 產生線上版
  （`lib/apidoc.js`，自動產生勿手改），再部署。**改 API 記得同步 API.md 與 AGENTS.md**。
- **圖片編號（`/img/編號`）永遠不能重複使用**：它掛一年不變的邊緣快取，且快取清不掉。
  換圖＝上傳新編號、改文章 cover，絕不要重設資料庫流水號。（踩過雷，詳見 ADMIN.md）
- **廣告版位**已內建但目前是空殼，等 Adsterra 代碼；計畫細節見 ADMIN.md 的「廣告計畫」章節。

---

*本專案為個人備份用途，儲存於私人 GitHub repo。*
