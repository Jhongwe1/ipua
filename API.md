# uaip.cc.cd API 文件

> **這份檔案是 API 文件的唯一原稿。** 線上版 <https://uaip.cc.cd/api-docs>（要管理金鑰）顯示的內容
> 就是本檔 — 改完本檔要執行 `node tools/build-apidoc.mjs` 重新產生 `lib/apidoc.js`，再部署。
> 給 AI agent 的操作指南（含常用流程與眉角）見 [AGENTS.md](./AGENTS.md)。

網頁後台能做的每一件事，這裡都有對應的 HTTP API — 用 curl、排程或 AI agent 都能操作整個網站。

## 1. 開始之前

| 項目 | 值 |
|---|---|
| 正式站 | `https://uaip.cc.cd`（等同 `https://uaip.pages.dev`） |
| 本機開發 | `http://localhost:8788`（`npx wrangler pages dev`） |
| 回應格式 | 一律 JSON（UTF-8） |
| 時間欄位 | 一律 UTC 的 ISO 8601（例 `2026-07-09T03:00:00.000Z`），顯示時自行轉時區 |

**三種身分**：

1. **公開**：免驗證（whoami、已發佈內容、選單、站名）。
2. **站長**：路徑含 `/admin` 的、以及 `/api/logs`。兩種通過方式（擇一）：
   - 請求標頭 `Authorization: Bearer <管理金鑰>`（curl／排程／AI agent 用）。管理金鑰＝Cloudflare Pages 環境變數 **LOGS_TOKEN**，跟 /logs、/admin 網頁登入同一把；值記在 ADMIN.md（不會上網）。
   - 站長 Google 帳號的登入 cookie（瀏覽器用）：站長信箱登入後，管理頁與站長 API 免金鑰。站長信箱＝環境變數 **ADMIN_EMAILS**（逗號分隔，預設 `zwwe1f@gmail.com`）。
   - **本機開發（localhost）免金鑰**；正式站沒帶或帶錯一律回 401。用 cookie 身分時，跨網站送出的請求會被 Origin 檢查擋掉（防 CSRF）。
   - 換金鑰：`printf '新金鑰' | npx wrangler pages secret put LOGS_TOKEN --project-name uaip`，跑完要重新部署才生效。
3. **會員**：任何人用 Google 登入即為會員（見 `/auth/login`）。會員功能（API 中轉、VPN 訂閱）要**站長核准**（status=approved）後才生效。
   - 網頁操作靠登入 cookie；**API 中轉**另用會員自己的金鑰 `uak-…`（在 /relay 頁產生，帶法同各家 AI API）。

### 30 秒上手：發一篇新聞

```bat
:: 1) 文章存成「UTF-8 編碼」的 art.json（中文寫在指令列會變亂碼，一定要走檔案）：
::    { "category":"news", "status":"published", "title":"標題",
::      "summary":"一兩句摘要", "cover":"/img/5", "body_md":"內文 **Markdown**" }
:: 2) 送出（Windows cmd 換行符是 ^；Linux/macOS 改用 \）：
curl -X POST https://uaip.cc.cd/api/admin/articles ^
  -H "Authorization: Bearer 管理金鑰" ^
  -H "content-type: application/json; charset=utf-8" ^
  --data-binary @art.json
```

回 `{ "id": 12, "status": "published" }` → 文章立即上線在 `/news/12`。

## 2. 端點總覽

### 公開（免金鑰）

| 方法與路徑 | 用途 |
|---|---|
| `GET /api/whoami` | 訪客自己的連線資訊（IP、UA、地理位置） |
| `GET /api/articles` | 已發佈文章列表（分頁、可篩分類） |
| `GET /api/articles/{id}` | 單篇已發佈文章（含 Markdown 原稿） |
| `GET /api/pages` | 已發佈自訂頁面列表 |
| `GET /api/pages/{slug}` | 單一已發佈自訂頁面 |
| `GET /api/menu` | 側邊欄選單 |
| `GET /api/settings` | 網站公開設定（站名） |
| `GET /img/{id}` | 圖片（D1 讀出、邊緣快取一年） |
| `GET /feed` | RSS 訂閱源（最新 20 篇） |
| `GET /sitemap` | 搜尋引擎網址清單（含文章與自訂頁面） |

### 會員（要登入 cookie）

| 方法與路徑 | 用途 |
|---|---|
| `GET /api/me` | 我是誰（登入狀態、被批准的服務清單 `services`、是否站長；未登入回 `{user:null}`） |
| `POST /api/account/key` | 產生／重生自己的中轉金鑰 `uak-…`（明文只回一次） |
| `DELETE /api/account/key` | 撤銷自己的中轉金鑰 |
| `POST /api/account/vpn-token` | 重生自己的 VPN 訂閱代碼（舊訂閱網址立即失效） |
| `GET /api/relay/channels` | 目前可用的中轉管道清單（含各管道的模型名稱 `models`；不含金鑰） |
| `GET /api/playground/models` | Playground 可選的模型清單（依渠道分組；要有 playground 服務） |
| `POST /api/playground/chat` | Playground 聊天（SSE 串流；要有 playground 服務，見 §5f） |
| `GET /api/playground/conversations` | 自己的 Playground 對話列表 |
| `GET/PUT/DELETE /api/playground/conversations/{id}` | 讀取訊息／改名／刪除自己的對話 |

### 會員服務端點（不同驗證）

| 方法與路徑 | 驗證 | 用途 |
|---|---|---|
| `ANY /relay/{管道}/{上游路徑…}` | 會員金鑰 `uak-…` | API 中轉：轉發到上游、串流直通（見 §6） |
| `GET /vpn/sub/{token}` | 訂閱 token 本身 | VPN 訂閱鏡像：給 Clash／v2rayN 直接訂閱（見 §7） |
| `GET /auth/login?next=…` | — | 導向 Google 登入（localhost 提供測試登入表單） |
| `POST /auth/logout` | 登入 cookie | 登出 |

### 站長（要金鑰）

| 方法與路徑 | 用途 |
|---|---|
| `GET /api/admin/articles` | 全部文章（**含草稿**，依更新時間排序，最多 500 筆） |
| `POST /api/admin/articles` | 新增文章 |
| `GET /api/admin/articles/{id}` | 讀單篇（含草稿、含原稿） |
| `PUT /api/admin/articles/{id}` | 更新文章（**整包覆蓋**） |
| `DELETE /api/admin/articles/{id}` | 刪除文章（不可復原） |
| `GET /api/admin/pages` | 全部自訂頁面（**含草稿**） |
| `POST /api/admin/pages` | **新增自訂頁面（開新連結就靠這支）** |
| `GET /api/admin/pages/{id或slug}` | 讀單頁（含草稿、含原稿） |
| `PUT /api/admin/pages/{id或slug}` | 更新頁面（**整包覆蓋**，可改 slug） |
| `DELETE /api/admin/pages/{id或slug}` | 刪除頁面（不可復原） |
| `POST /api/admin/media` | 上傳圖片 |
| `PUT /api/admin/menu` | 覆蓋側邊欄選單 |
| `PUT /api/admin/settings` | 改網站設定（站名） |
| `GET /api/logs` | 訪客紀錄查詢 |
| `GET /api/admin/apidoc` | 這份文件的 Markdown 原稿（`{ md }`） |
| `GET /api/admin/users` | 全部會員（狀態、已批准服務、用量、最後登入） |
| `PUT /api/admin/users/{id}` | 批准／封鎖／升降管理員／分服務批准（`{ action }`，見 §5c） |
| `DELETE /api/admin/users/{id}` | 刪除會員 |
| `GET /api/admin/relay/channels` | 全部中轉管道（上游金鑰遮罩） |
| `POST /api/admin/relay/channels` | 新增中轉管道 |
| `PUT /api/admin/relay/channels/{id}` | 更新管道（整包覆蓋；沒帶 api_key＝保留舊金鑰） |
| `DELETE /api/admin/relay/channels/{id}` | 刪除管道 |
| `GET /api/admin/vpn/channels` | 全部 VPN 渠道（上游訂閱網址遮罩） |
| `POST /api/admin/vpn/channels` | 新增 VPN 渠道（機場訂閱或手動節點） |
| `PUT /api/admin/vpn/channels/{id}` | 更新渠道（整包覆蓋；沒帶 url＝保留舊網址） |
| `DELETE /api/admin/vpn/channels/{id}` | 刪除渠道 |

## 3. 三條鐵則（先讀這個再動手）

1. **PUT 是整包覆蓋**（文章、頁面、選單都是）：先 GET 拿舊資料 → 改要改的欄位 → 整包 PUT 回去。沒帶的欄位會被清空。
2. **圖片編號永遠不能重複使用**：`/img/{id}` 掛一年 immutable 邊緣快取，而 uaip.cc.cd 的快取清除權在 cc.cd 網域主手上、我們清不掉。刪過的編號作廢；換圖＝上傳拿新編號＋更新文章裡的網址。也**不要**重設 media 表的流水號。
3. **中文內容一定走 UTF-8 檔案**：curl 用 `--data-binary @檔案` 傳送；把中文直接寫在 Windows 指令列會變亂碼（實測踩過）。

## 4. 公開 API 詳細

### GET /api/whoami

回傳由 Cloudflare 邊緣節點觀測到的請求資訊。欄位：`ip`、`ua`、`lang`、`country`、`city`、`region`、`region_code`、`postal`、`latitude`、`longitude`、`timezone`、`asn`、`isp`、`colo`、`http`、`tls`。

### GET /api/articles — 已發佈文章列表

| 參數 | 說明 |
|---|---|
| `category` | `news` 或 `article`；省略＝全部 |
| `p` | 頁碼，預設 1 |
| `per` | 每頁筆數 1–50，預設 10 |

回 `{ rows, total, page, per, pages }`；rows 每筆含 `id`、`category`、`title`、`summary`、`cover`、`views`、`published_at`，依發佈時間新到舊。草稿一律看不到；用 API 讀**不會**增加瀏覽數（views 只算真人看文章頁）。

### GET /api/articles/{id} — 單篇已發佈文章

回 `{ row }`，含 `body_md`（Markdown 原稿）。加 **`?html=1`** 多回 `body_html`（伺服器轉好的 HTML，跟正式文章頁同設定）。找不到或還是草稿 → 404。

### GET /api/pages — 已發佈自訂頁面列表

回 `{ rows }`，每筆含 `slug`、`title`、`summary`、`updated_at`。每頁的公開網址＝ **`/p/{slug}`**（例 slug=about → `https://uaip.cc.cd/p/about`）。

### GET /api/pages/{slug} — 單一已發佈自訂頁面

回 `{ row }`，含 `body_md`。加 **`?html=1`** 多回 `body_html`。找不到或還是草稿 → 404。

### GET /api/menu — 側邊欄選單

回 `{ items, custom }`。items 是「由上到下」的平面陣列，每項：

| 欄位 | 說明 |
|---|---|
| `kind` | `section`（分類標題）或 `link`（連結） |
| `label` | 中文名稱 |
| `label_en` | 英文名稱（空字串＝英文介面也顯示中文） |
| `url` | 連結網址（section 為空字串） |

`custom:false` 表示還沒自訂過，回的是內建預設選單。

### GET /api/settings — 網站公開設定

回 `{ brand, custom }`。brand＝站名（用在分頁標題、og:site_name、JSON-LD、RSS 頻道名）；`custom:false` 表示用內建預設。

## 5. 站長 API 詳細

### 文章：/api/admin/articles

POST（新增）與 PUT（更新）共用同一組 JSON 欄位：

| 欄位 | 規則 |
|---|---|
| `category` | `news`（新聞）或 `article`（文章）；預設 news |
| `status` | `draft`（草稿）或 `published`（發佈）；預設 draft |
| `title` | **必填**，最長 200 字 |
| `summary` | 最長 500 字 — 列表兩行摘要，也是搜尋結果與分享卡描述 |
| `cover` | 縮圖網址，最長 300 字（通常是 `/img/{id}`，也可貼外部網址） |
| `body_md` | 內文 Markdown，最長 200KB（空一行分段、`## 小標`、`**粗體**`、`[文字](網址)`、插圖 `![說明](/img/{id})`；breaks 模式：按一次 Enter 就是換行） |

- POST 回 `{ id, status }`；PUT 回 `{ id, status }`；DELETE 回 `{ ok:true }`。
- `published_at` 在**第一次發佈**時寫入，之後再編輯、轉草稿再發佈都不變（列表排序穩定）。
- 文章上線網址：`/news/{id}` 或 `/articles/{id}`（依 category）。

### 自訂頁面：/api/admin/pages — 用 API 開新連結

新增一個頁面＝網站多一個公開網址 **`/p/{slug}`**。適合「關於本站」「隱私權政策」「聯絡方式」這類獨立頁。

POST 與 PUT 共用欄位：

| 欄位 | 規則 |
|---|---|
| `slug` | **必填** — 網址代稱：小寫英數與連字號（頭尾不能是連字號），最長 64 字。例 `about`、`privacy-policy` |
| `title` | **必填**，最長 200 字（頁面大標＋分頁標題） |
| `status` | `draft`（草稿）或 `published`（發佈）；預設 draft。**草稿對外看不到** |
| `summary` | 最長 500 字 — meta description（SEO 與分享卡描述） |
| `body_md` | 內文 Markdown，最長 200KB（規則同文章） |

- POST 回 `{ id, slug, status, url }`；slug 已被用回 **409 `{ error:"slug-taken" }`**。
- 單頁路由 `/{id或slug}`：純數字當編號、其他當 slug，兩種都可以（agent 用 slug 比較直覺）。
- PUT 可以改 slug（頁面搬新網址，舊網址會變 404 — 已被收錄或被連結的頁面不建議改）。
- 發佈後自動進 `/sitemap`；**不會**自動出現在側邊欄 — 要掛選單就再 `PUT /api/admin/menu` 加一條 url 為 `/p/{slug}` 的連結（見下）。

建立並發佈一個「關於本站」頁：

```bat
:: page.json（UTF-8）：
::   { "slug":"about", "status":"published", "title":"關於本站",
::     "summary":"這個網站是誰、在做什麼。", "body_md":"## 哈囉\n\n這裡是……" }
curl -X POST https://uaip.cc.cd/api/admin/pages ^
  -H "Authorization: Bearer 管理金鑰" ^
  -H "content-type: application/json; charset=utf-8" --data-binary @page.json
:: 回 { "id":1, "slug":"about", "status":"published", "url":"/p/about" }
```

### 圖片：POST /api/admin/media

- 請求本體＝圖片**二進位**（不是表單、不是 base64），Content-Type 帶 `image/webp`、`image/jpeg`、`image/png` 或 `image/gif`。
- 大小上限 **1.8MB**（D1 單值限 2MB）。走 API 上傳**不會自動壓縮**，請先自己縮好（建議最寬 1400–1600px、JPEG 品質 85 左右）；網頁後台上傳才有自動壓縮。
- 可選參數 `?w=寬&h=高`（記尺寸，後台顯示用）。
- 回 `{ id, url, bytes, w, h }`，url 形如 `/img/9` — 填進文章 cover，或以 `![說明](/img/9)` 插進內文。

```bat
curl -X POST "https://uaip.cc.cd/api/admin/media?w=1400&h=788" ^
  -H "Authorization: Bearer 管理金鑰" ^
  -H "content-type: image/jpeg" --data-binary @cover.jpg
```

### 選單：PUT /api/admin/menu

本體 `{ "items": [ … ] }`，格式同 GET /api/menu 的 items；整份選單照陣列順序**覆蓋**寫入。

- 每項規則：`label` 必填最長 60 字；`label_en` 選填最長 60 字；link 的 `url` 必填最長 300 字，**必須以 `/` 或 `http://` 或 `https://` 開頭**；最多 60 項。
- 傳 **`{ "items": [] }`（空陣列）＝清掉自訂選單＝還原內建預設**。
- 回 `{ ok, count, custom }`。
- 側邊欄的「站長區」（文章管理、訪客紀錄、API 文件）不在選單資料裡 — 那是登入過的裝置由前端動態長出來的，改不到也不用管。

標準流程（先拿現況、改完整包放回）：

```bat
curl https://uaip.cc.cd/api/menu > menu.json
:: 編輯 menu.json，例如 items 尾端加 { "kind":"link", "label":"關於本站",
::   "label_en":"About", "url":"/p/about" }，然後：
curl -X PUT https://uaip.cc.cd/api/admin/menu ^
  -H "Authorization: Bearer 管理金鑰" ^
  -H "content-type: application/json; charset=utf-8" --data-binary @menu.json
```

### 站名：PUT /api/admin/settings

本體 `{ "brand": "新站名" }`（最長 60 字）。**brand 傳空字串＝還原內建預設站名**。回 `{ ok, brand, custom }`。改完立即生效（分頁標題、og:site_name、JSON-LD、RSS 頻道名；主站首頁的「IP·UA 查詢」標題不受影響）。

```bat
curl -X PUT https://uaip.cc.cd/api/admin/settings ^
  -H "Authorization: Bearer 管理金鑰" ^
  -H "content-type: application/json" --data-binary "{\"brand\":\"新站名\"}"
```

### 訪客紀錄：GET /api/logs

| 參數 | 說明 |
|---|---|
| `limit` | 1–200，預設 50 |
| `offset` | 分頁位移 |
| `q` | 模糊搜尋（ip / ua / path / country / city / isp） |
| `since` | ISO 時間 — 額外回傳該時間之後的瀏覽數與不重複 IP 數（today / todayIps） |

回 `{ rows, total, today?, todayIps? }`。

## 5b. 會員與帳號 API

- `GET /api/me` → `{ user }`（未登入 `{ user:null }`）。user 含 `email`、`name`、`picture`、`status`（pending/approved/blocked）、`is_admin`、`approved`、`services`（被批准的服務陣列，如 `["relay","vpn","playground"]`；站長固定是全部）、`has_key`、`key_hint`、`key_at`、`vpn_token`、`relay_calls`、`vpn_pulls`。
- `POST /api/account/key` → `{ key, key_hint, key_at }`。**key 明文只在這次回應出現**，資料庫只存 SHA-256；重生會讓舊金鑰立即失效。`DELETE` 撤銷。
- `POST /api/account/vpn-token` → `{ vpn_token }`。重生訂閱代碼（舊 `/vpn/sub/<舊token>` 立即失效）。
- 以上都要登入 cookie；跨站請求被 Origin 擋（403 bad-origin）。

## 5c. 成員管理：/api/admin/users（分服務批准）

2026-07-13 起改**分服務批准**：三個服務 `relay`（API 中轉站）、`vpn`、`playground`（LLM Playground）可以分別開關，存在 `users.services`（逗號分隔）。站長帳號不看清單、全部服務都能用。

- `GET` → `{ rows }`：每筆 `id`、`email`、`name`、`picture`、`status`、`services`（逗號分隔字串）、`is_admin`、`relay_calls`、`vpn_pulls`、`last_login`、`created_at`；排序 pending 在前。
- `PUT /api/admin/users/{id}` 本體二選一：
  - `{ "action": "approve" | "block" | "unblock" | "make_admin" | "drop_admin" }` — `approve` 是快速鍵＝**一次批准全部服務**；`unblock` 恢復原本的服務清單（清單是空的就退回 pending）。封鎖會同時把該會員踢下線（刪其 session）。
  - `{ "action": "set_services", "services": ["relay","vpn"] }` — **整包覆蓋**服務清單（只收合法服務名）。給了任何服務＝status 變 approved；全部收回＝退回 pending；封鎖中的帳號只改清單、狀態不動。
- `DELETE /api/admin/users/{id}` 刪除帳號。
- **護欄**：不能封鎖／降級／刪除自己；也不能動到 ADMIN_EMAILS 指定的站長帳號（回 403 protected — 要改就改環境變數）。

## 5d. API 中轉站

**站長設管道**（存 `relay_channels` 表）：`POST /api/admin/relay/channels`，本體：

| 欄位 | 規則 |
|---|---|
| `slug` | **選填** 網址代稱（小寫英數與連字號）。留空＝自動從名稱產生（轉不出英數就隨機 `ch-xxxxxx`，撞名自動補尾碼）；**PUT 時留空＝沿用舊代稱**（會員的 /relay 網址不變）。網頁表單 2026-07-14 起已不顯示這欄 |
| `name` | **必填** 顯示名稱 |
| `kind` | `openai`（含所有 OpenAI 相容服務與本地 AI）／`anthropic`／`gemini`／`custom`；決定金鑰帶給上游的方式 |
| `base_url` | **必填** 上游根網址，例 `https://api.openai.com` |
| `api_key` | 上游金鑰（只有站長 API 摸得到，回讀一律遮罩） |
| `models` | **必填** 這個管道可用的模型名稱（陣列，或逗號／換行分隔的字串；限英數與 `. _ / : -`、上限 40 個）。會員頁與 LLM Playground 都靠這份清單 |
| `enabled` | 預設 true |

- `GET` → `{ rows }`，每筆含 `models`（陣列）、`has_key`、`key_hint`（金鑰一律遮罩）。
- `PUT /api/admin/relay/channels/{id}` 整包覆蓋（**`models` 也要帶齊**）；**本體沒帶 `api_key` 欄位＝保留舊金鑰**（帶空字串＝清掉）。
- 網頁上新增管道時，選 kind 會自動帶入該家的**官方 Base URL**；用其他供應商（便宜渠道／自架／本地模型）直接改掉即可（你手打過的網址不會被自動蓋掉）。
- 會員看的 `GET /api/relay/channels` → `{ rows:[{ slug, name, kind, models }], approved }`（approved＝有沒有被批准 relay 服務）；/relay 頁上每個模型名稱都有一鍵複製。

**上游金鑰放哪個標頭：依「路徑」決定，不是只看 kind**（2026-07-12 實測修正）。各家都有兩套介面：

| 上游路徑 | 中轉送出的驗證頭 |
|---|---|
| 含 `/openai/` 或結尾是 `chat/completions`（各家的 **OpenAI 相容層**） | `Authorization: Bearer` |
| Anthropic 原生 `v1/messages` | `x-api-key` |
| Gemini 原生 `v1beta/models/…` | `x-goog-api-key` |
| 其他（openai／custom） | `Authorization: Bearer` |

> ⚠️ **Gemini 原生端點不能多送 `Authorization`**：Google 一看到這個標頭就當成 OAuth token，直接回 401「API keys are not supported by this API」。所以是二選一，不能兩個都送。

**會員使用**：把 AI 工具的 Base URL 設成 `https://uaip.cc.cd/relay/{slug}`、API Key 填自己的 `uak-…`：

```
POST https://uaip.cc.cd/relay/openai/v1/chat/completions
Authorization: Bearer uak-你的金鑰
→ 伺服器驗身分＋核准狀態 → 換成站長存的上游金鑰 → 轉發到 https://api.openai.com/v1/chat/completions
```

- 金鑰放哪都收：`Authorization: Bearer`、`x-api-key`、`x-goog-api-key`、`?key=`（配合各家 SDK）。
- 路徑照上游原本的填（中轉只換金鑰不改路徑）；回應串流直通。`model` 參數也原樣轉發 — 填管道 `models` 清單裡的名稱即可。
- 未帶金鑰 401、金鑰無效 401、帳號未被批准 relay 服務 403、管道不存在或停用 404、上游連不上 502。

## 5e. VPN 訂閱（多渠道）

跟中轉站同一個模式：站長到處找便宜機場／自架節點，**每找到一個就加一個渠道**；會員永遠只有一條訂閱網址，伺服器把所有「啟用中」渠道的節點合併給他，**會員看不到渠道存在，也看不到上游網址**。

**站長設渠道**（存 `vpn_channels` 表）：`POST /api/admin/vpn/channels`，本體：

| 欄位 | 規則 |
|---|---|
| `name` | **必填** 顯示名稱（只有站長看得到，例「某機場 月付3元」） |
| `kind` | `sub`（機場給的訂閱網址，預設）或 `nodes`（自己貼的節點連結） |
| `url` | `kind=sub` **必填**：上游訂閱網址（回讀一律遮罩） |
| `nodes` | `kind=nodes` **必填**：一行一條 `vmess://`／`vless://`／`trojan://`… |
| `enabled` | 預設 true；false＝暫時不併進會員訂閱（渠道還留著） |

- `PUT /api/admin/vpn/channels/{id}` 整包覆蓋；**本體沒帶 `url` 欄位＝保留舊網址**（帶空字串＝清掉）。
- `GET /api/admin/vpn/channels` → `{ rows }`，每筆 `id`、`name`、`kind`、`enabled`、`has_url`、`url_hint`（遮罩）、`nodes`、`node_count`。

**會員使用**：`GET /vpn/sub/{token}`（token＝會員的 `vpn_token`，等於通行證，免登入方便 App 定時抓）。把這網址加進 Clash／v2rayN／Shadowrocket 的訂閱即可。未核准／被封鎖 → 403。

伺服器依渠道數自動選最相容的合併方式：

| 啟用中的渠道 | 回給會員的內容 |
|---|---|
| 只有 `nodes` 渠道 | 全部手動節點，合併去重 → 標準 base64 訂閱 |
| 恰好 1 個 `sub` 渠道 | **原樣轉發**（透傳會員 App 的 UA，所以機場回 Clash YAML 也沒問題；流量／到期資訊 Subscription-Userinfo 照傳）。上游若是 base64，手動節點會解碼附加後重新編碼 |
| 2 個以上 `sub` 渠道 | 各渠道用 v2rayN UA 並行抓取（邊緣快取 5 分鐘）→ 解碼 → 全部節點＋手動節點合併去重 → 一份 base64 訂閱。解不開的（Clash YAML）略過；多渠道時流量資訊無法合併，不回傳 |

> 想同時吃多個機場又要保留流量顯示，就只啟用那一個機場的渠道；其餘用 `enabled:false` 暫存。

## 5f. LLM Playground（/playground）

會員在網頁上直接試用中轉渠道裡的模型（2026-07-13 上線）。可選的模型＝各中轉管道的 `models` 清單；
上游金鑰全程留在伺服器，會員只帶登入 cookie。對話存 D1、綁帳號、跨裝置同步。
驗證：登入 cookie（要有 `playground` 服務）**或** `Authorization: Bearer <管理金鑰>`（以站長帳號的身分操作，方便 curl／agent 測試）。

- `GET /api/playground/models` → `{ rows:[{ slug, name, models }] }`（只列啟用中且有設模型的渠道；**不含 `kind`** — 那等於標示真實提供商）。
- `GET /api/playground/conversations` → `{ rows:[{ id, title, channel, model, created_at, updated_at }] }`（自己的，新→舊，最多 100 筆）。
- `GET /api/playground/conversations/{id}` → `{ conv, messages:[{ id, role, content, model, created_at }] }`。
- `PUT /api/playground/conversations/{id}` 本體 `{ "title":"新名字" }` 改名；`DELETE` 刪除（連同訊息）。
- `POST /api/playground/chat` 本體：

```json
{ "conv_id": 12, "channel": "gemini", "model": "gemini-3.1-flash-lite",
  "messages": [ { "role":"user", "content":"你好" } ] }
```

  - `messages` 是完整上下文（最後一則要是 `user`；`role` 收 user/assistant/system）。
  - **不帶 `conv_id`＝自動開新對話**（標題取第一句 user 訊息），對話編號由 SSE 第一筆事件回傳。
  - `model` 一定要在該渠道的 `models` 清單裡，否則 400 `bad-model`。
  - 回應是 SSE（`text/event-stream`），每筆 `data:` 都是 JSON：`{conv,title?}` →（多筆）`{d:"增量文字"}` → `{done:true}`；中途出錯是 `{error,hint}`（已生成的部分照存）。上游一開始就失敗則直接回 JSON 錯誤（會帶 `conv`）。
  - 中斷連線（前端按「停止」）＝停止生成，已生成的內容照樣存進對話。
  - 伺服器依渠道 kind 自動轉換請求／串流格式：openai、custom → `/v1/chat/completions`；anthropic → `/v1/messages`；gemini → `/v1beta/models/{model}:streamGenerateContent?alt=sse`。
  - **錯誤訊息對會員做了消毒**（2026-07-14）：上游的原始錯誤內容（錯誤格式、文件連結、專案編號）會洩漏真實提供商身分，所以會員只看得到安全分類字（401/403→「渠道憑證可能失效」、429→「上游流量限制」、5xx→「上游暫時故障」…），`detail` 原文**只有站長**（is_admin 或管理金鑰）看得到。

## 6. 常用流程速查

| 想做的事 | 步驟 |
|---|---|
| 發文 | （可選）POST media 拿 `/img/{id}` → POST /api/admin/articles（status:published） |
| 改文 | GET /api/admin/articles/{id} → 改欄位 → **整包** PUT 回去 |
| 換圖 | POST media 拿**新**編號 → PUT 文章把 cover / 內文網址換成新的（舊編號作廢） |
| 開新頁面 | POST /api/admin/pages（status:published）→ 上線在 `/p/{slug}` |
| 頁面掛進選單 | GET /api/menu → items 加 `{ kind:"link", label, url:"/p/{slug}" }` → PUT /api/admin/menu |
| 改站名 | PUT /api/admin/settings `{ "brand":"…" }` |
| 看流量 | GET /api/logs?limit=50&since=今天零點的UTC時間 |
| 加中轉管道 | POST /api/admin/relay/channels `{ name, kind, base_url, api_key, models:["gpt-4o-mini"] }`（slug 自動產生） |
| 批准會員（全部服務） | GET /api/admin/users 找 id → PUT /api/admin/users/{id} `{ "action":"approve" }` |
| 批准／收回單一服務 | PUT /api/admin/users/{id} `{ "action":"set_services", "services":["relay","playground"] }`（整包覆蓋） |
| 加 VPN 渠道 | POST /api/admin/vpn/channels `{ "name":"某機場", "kind":"sub", "url":"https://…" }` |
| 暫停某渠道 | GET /api/admin/vpn/channels 找 id → PUT `{ name, kind, enabled:false }`（會員訂閱立刻少掉那些節點） |

轉貼別站新聞的原則：**用自己的話改寫＋文末附資料來源連結**，不要整篇照抄。
這些操作在網頁上也都能做：文章後台 /admin、☰ 側邊欄「站長」區（改選單、改站名、成員管理）、訪客紀錄 /logs、中轉站 /relay、VPN /vpn（自訂頁面目前只有 API）。

## 7. 錯誤回應

出錯時回 `{ "error": "代碼", "hint": "中文提示（可能沒有）", "detail": "技術細節（可能沒有）" }`：

| HTTP 狀態 | 常見 error | 說明 |
|---|---|---|
| 400 | bad-input / bad-id / bad-slug / bad-url / too-many / empty / bad-action / self / bad-model | 參數或本體不合規則（看 hint）；bad-model＝模型不在渠道清單裡 |
| 401 | unauthorized / no-key / bad-key / no-admin-user | 金鑰沒帶或不對（中轉：會員金鑰無效） |
| 403 | bad-origin / not-approved / blocked / protected | 跨站被擋／該服務未被批准或帳號被封鎖／受保護的站長帳號 |
| 404 | not-found / unknown-channel | 內容不存在（或公開 API 查到的是草稿）／中轉管道不存在 |
| 409 | slug-taken | 自訂頁面或管道的 slug 已被使用 |
| 502 | upstream-unreachable / upstream-error / no-upstream-key | 中轉／VPN／Playground 上游連不上或回錯；渠道沒設上游金鑰 |
| 413 | too-large | 圖片超過 1.8MB |
| 415 | bad-type | 圖片格式不是 webp / jpeg / png / gif |
| 500 | no-db / query-failed / insert-failed / update-failed / delete-failed / save-failed | 伺服器或資料庫問題（看 detail） |
