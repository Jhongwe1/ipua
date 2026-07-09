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

> 詳細的站長維護筆記、金鑰、各種眉角，請看 **[ADMIN.md](./ADMIN.md)**。
> 要讓 AI agent 接手操作網站（發文、開頁面、改選單…），指南在
> **[.claude/skills/uaip-api/SKILL.md](./.claude/skills/uaip-api/SKILL.md)** —
> 用 Claude Code 開這個專案時會自動當成 skill 載入。
> 這份 README 只講「這是什麼、怎麼跑起來」，方便在新電腦或新環境接手。

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
├─ ADMIN.md          ← 站長詳細筆記（含金鑰、維護指令、廣告計畫）
├─ .claude/skills/uaip-api/  ← 給 AI agent 的網站操作指南（API 用法與眉角）
├─ db/schema.sql     ← 資料表結構（visits 訪客／articles 文章／media 圖片／pages 自訂頁面／menu 選單／settings 設定）
├─ lib/              ← Functions 共用程式（site.js 外殼、pages.js 渲染、apidoc.js API 文件、vendor/marked）
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
  文件在 `/api-docs`（原稿 `lib/apidoc.js`）；**改 API 記得同步更新文件與 agent skill**。
- **圖片編號（`/img/編號`）永遠不能重複使用**：它掛一年不變的邊緣快取，且快取清不掉。
  換圖＝上傳新編號、改文章 cover，絕不要重設資料庫流水號。（踩過雷，詳見 ADMIN.md）
- **廣告版位**已內建但目前是空殼，等 Adsterra 代碼；計畫細節見 ADMIN.md 的「廣告計畫」章節。

---

*本專案為個人備份用途，儲存於私人 GitHub repo。*
