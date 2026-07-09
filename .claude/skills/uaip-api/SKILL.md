---
name: uaip-api
description: 操作 uaip.cc.cd 網站的完整指南 — 發佈新聞/文章、上傳圖片、新增自訂頁面（開新連結）、改側邊欄選單、改站名、查訪客紀錄。凡是要「在網站上」新增或修改內容時使用（不是改程式碼時）。
---

# uaip.cc.cd 網站操作（API）

這個網站的所有內容操作都走 HTTP API，不需要改程式碼、不需要重新部署。
改「內容」用本文件的 API；改「程式或版型」才動 repo（改完 `npx wrangler pages deploy`）。

## 基本資料

- 正式站：`https://uaip.cc.cd`（等同 `https://uaip.pages.dev`）
- 本機開發：`http://localhost:8788`（`npx wrangler pages dev`；**localhost 免金鑰**，先在本機試最安全）
- 管理金鑰：讀專案根目錄 **ADMIN.md** 的「管理金鑰（LOGS_TOKEN）」段落
- 站長 API（路徑含 `/admin` 的與 `/api/logs`）都要帶：`Authorization: Bearer <金鑰>`
- 回應一律 JSON；時間一律 UTC ISO 8601
- 完整逐端點文件：`lib/apidoc.js`（線上版 /api-docs，要金鑰）

## 三條鐵則（違反會出事）

1. **PUT 一律整包覆蓋**（文章、頁面、選單）：先 GET 現況 → 只改要改的欄位 → 整包 PUT。漏帶的欄位會被清空。
2. **圖片編號（/img/{id}）永遠不能重複使用**：掛一年 immutable 邊緣快取且清不掉。換圖＝上傳拿新編號＋更新引用；絕不重設 media 表流水號、不重用刪過的編號。
3. **中文必走 UTF-8 檔案**：JSON 先寫進 UTF-8 檔，`curl --data-binary @檔案` 送出。中文直接寫在 Windows 指令列會亂碼。

另外：轉貼別站新聞要**用自己的話改寫＋文末附來源連結**，不可整篇照抄。

## 端點速查

公開（免金鑰）：

| 端點 | 用途 |
|---|---|
| `GET /api/articles?category=news|article&p=1&per=10` | 已發佈文章列表 |
| `GET /api/articles/{id}`（可加 `?html=1`） | 單篇已發佈文章 |
| `GET /api/pages` / `GET /api/pages/{slug}` | 已發佈自訂頁面 |
| `GET /api/menu` | 側邊欄選單 `{ items, custom }` |
| `GET /api/settings` | 站名 `{ brand, custom }` |
| `GET /api/whoami`、`/img/{id}`、`/feed`、`/sitemap` | 連線資訊、圖片、RSS、sitemap |

站長（要金鑰）：

| 端點 | 用途 |
|---|---|
| `GET/POST /api/admin/articles`、`GET/PUT/DELETE /api/admin/articles/{id}` | 文章 CRUD（含草稿） |
| `GET/POST /api/admin/pages`、`GET/PUT/DELETE /api/admin/pages/{id或slug}` | 自訂頁面 CRUD |
| `POST /api/admin/media?w=寬&h=高` | 上傳圖片（本體＝二進位，Content-Type 帶圖片格式，上限 1.8MB，**不會自動壓縮**） |
| `PUT /api/admin/menu` | 整包覆蓋選單；`{ "items": [] }`＝還原預設 |
| `PUT /api/admin/settings` | `{ "brand": "站名" }`；空字串＝還原預設 |
| `GET /api/logs?limit=&offset=&q=&since=` | 訪客紀錄 |
| `GET /api/admin/apidoc` | 完整 API 文件原稿 `{ md }` |

## 常用流程

### 發一篇新聞／文章

```bash
# （可選）先傳封面圖，拿 /img/{id}；圖要先自己壓到 1.8MB 以下、建議最寬 1400-1600px
curl -X POST "https://uaip.cc.cd/api/admin/media?w=1400&h=788" \
  -H "Authorization: Bearer $TOKEN" -H "content-type: image/jpeg" --data-binary @cover.jpg

# art.json（UTF-8）：category 是 news 或 article；status 給 draft 就是存草稿
# { "category":"news", "status":"published", "title":"標題",
#   "summary":"一兩句摘要（列表與 SEO 用）", "cover":"/img/5", "body_md":"內文 **Markdown**" }
curl -X POST https://uaip.cc.cd/api/admin/articles \
  -H "Authorization: Bearer $TOKEN" \
  -H "content-type: application/json; charset=utf-8" --data-binary @art.json
# 回 { "id":12, "status":"published" } → 上線在 /news/12（article 分類則是 /articles/12）
```

body_md 是 Markdown（breaks 模式：單一 Enter 就換行）；內文插圖寫 `![說明](/img/{id})`。

### 修改文章

```bash
curl https://uaip.cc.cd/api/admin/articles/12 -H "Authorization: Bearer $TOKEN" > cur.json
# 取 cur.json 的 row，改欄位後把「六個欄位都帶齊」（category/status/title/summary/cover/body_md）存成 art.json
curl -X PUT https://uaip.cc.cd/api/admin/articles/12 \
  -H "Authorization: Bearer $TOKEN" \
  -H "content-type: application/json; charset=utf-8" --data-binary @art.json
```

### 開一個新頁面（新連結）

自訂頁面上線在 `/p/{slug}`，適合「關於本站」「隱私權政策」這類獨立頁：

```bash
# page.json（UTF-8）：slug 只能小寫英數與連字號（頭尾不能是連字號），重複會回 409
# { "slug":"about", "status":"published", "title":"關於本站",
#   "summary":"SEO 描述", "body_md":"## 內容\n\n……" }
curl -X POST https://uaip.cc.cd/api/admin/pages \
  -H "Authorization: Bearer $TOKEN" \
  -H "content-type: application/json; charset=utf-8" --data-binary @page.json
# 回 { "id":1, "slug":"about", "status":"published", "url":"/p/about" }
```

發佈後自動進 sitemap，但**不會自動進側邊欄** — 要掛選單就接著做下一個流程。
更新用 `PUT /api/admin/pages/about`（id 或 slug 都可）；PUT 可改 slug＝搬網址（已被收錄的頁面別亂改）。

### 把連結掛進側邊欄選單

```bash
curl https://uaip.cc.cd/api/menu > menu.json
# 在 menu.json 的 items 適當位置插入（kind:"section" 是分組小標題、"link" 是連結）：
#   { "kind":"link", "label":"關於本站", "label_en":"About", "url":"/p/about" }
# url 必須以 / 或 http(s):// 開頭；整份 items 就是選單的最終樣子（整包覆蓋）
curl -X PUT https://uaip.cc.cd/api/admin/menu \
  -H "Authorization: Bearer $TOKEN" \
  -H "content-type: application/json; charset=utf-8" --data-binary @menu.json
```

### 查流量

```bash
curl "https://uaip.cc.cd/api/logs?limit=50&since=2026-07-08T16:00:00Z" \
  -H "Authorization: Bearer $TOKEN"
# 回 { rows, total, today, todayIps }；q= 可模糊搜 ip/ua/path/country/isp
```

## 做完怎麼驗證

- 發文後：開 `/news/{id}`（或 `/articles/{id}`）確認 200 且內容正確；列表頁 `/news` 應出現該篇。
- 開頁面後：開 `/p/{slug}` 確認 200；`GET /api/pages` 應列出它。
- 改選單後：任一頁重新整理，☰ 側邊欄應反映新選單（`GET /api/menu` 先確認資料）。
- 草稿驗證：公開 API（`/api/articles/{id}`、`/api/pages/{slug}`）對草稿回 404 才是對的。

## 錯誤格式

`{ "error":"代碼", "hint":"中文提示?", "detail":"技術細節?" }` — 常見：400 bad-input/bad-slug（看 hint）、401 unauthorized（金鑰）、404 not-found（不存在或是草稿）、409 slug-taken、413 too-large（圖 >1.8MB）、415 bad-type（圖片格式）。

## 改到程式碼時的提醒

- 部署：`npx wrangler pages deploy`（**不要加任何參數，尤其不要加「.」**）。
- 動了 `db/schema.sql`：本機 `npx wrangler d1 execute ipua-logs --local --file db/schema.sql`、正式 `--remote`（schema 全是 IF NOT EXISTS，可重複執行）。
- 改了任何 API：同步更新 `lib/apidoc.js` 與這份 SKILL.md。
- 其他維護眉角（金鑰更換、備份、廣告計畫）見 ADMIN.md。
