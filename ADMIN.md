# 站長筆記（此檔在 public/ 之外，不會被部署上網）

## 網站結構（2026-07-06 新聞／文章系統上線後）

```
ipua/
├─ wrangler.toml          ← Pages 設定：專案名、輸出資料夾、D1 綁定
├─ ADMIN.md               ← 這份筆記
├─ API.md                 ← 完整 API 文件（**唯一原稿**，GitHub 直接可讀；線上 /api-docs 由它產生）
├─ AGENTS.md              ← 給 AI agent 的操作指南（金鑰在哪、流程照抄、驗證清單）
├─ .claude/skills/uaip-api/SKILL.md ← Claude Code skill 入口（薄殼，指向 AGENTS.md／API.md）
├─ tools/build-apidoc.mjs ← 把 API.md 轉成 lib/apidoc.js（改完 API.md 要跑一次再部署）
├─ db/schema.sql          ← 資料表結構（visits 訪客＋articles 文章＋media 圖片＋pages 自訂頁面＋menu 選單＋settings 設定）
├─ lib/                   ← Functions 共用程式（部署時自動打包，不會上網）
│  ├─ site.js             ← 頁面外殼（pageShell）、管理頁共用樣式（ADMIN_CSS）、站長驗證、共用工具；
│  │                         DEFAULT_MENU 預設選單、getChrome 讀選單/站名、SLUG_RE 頁面代稱規則
│  ├─ pages.js            ← 新聞/文章「列表頁與文章頁」的實際內容（antutu 式排版、SEO 標籤）
│  ├─ apidoc.js           ← ⚠ 自動產生（node tools/build-apidoc.mjs），不要手改；原稿是 API.md
│  └─ vendor/marked.mjs   ← Markdown 轉 HTML 函式庫（marked 18.0.5，已內建免安裝）
├─ functions/             ← Cloudflare Pages Functions（伺服端程式）
│  ├─ _middleware.js      ← 每次頁面瀏覽 → 寫一筆到 D1（不記 /api*、/logs、/admin、/img）
│  ├─ logs.js             ← GET /logs 訪客紀錄管理頁（2026-07-09 起用共用外殼；行為在 assets/logs.js）
│  ├─ admin.js            ← GET /admin 文章管理後台（同上；行為在 assets/admin.js；支援 ?edit=、?new=）
│  ├─ news/index.js       ← GET /news 新聞列表（?p=2 換頁）
│  ├─ news/[id].js        ← GET /news/12 單篇新聞
│  ├─ articles/…          ← GET /articles、/articles/34（同上，文章分類）
│  ├─ p/[slug].js         ← GET /p/about 自訂頁面（內容存 pages 表，用 API 建立）
│  ├─ img/[id].js         ← GET /img/5 從 D1 讀圖（邊緣快取）
│  ├─ feed.js             ← GET /feed RSS 訂閱源
│  ├─ sitemap.js          ← GET /sitemap 給搜尋引擎的網址清單（含文章與自訂頁面）
│  ├─ api-docs.js         ← GET /api-docs API 文件頁（金鑰閘門，站長才看得到內容）
│  └─ api/
│     ├─ whoami.js        ← GET /api/whoami（回報訪客自己的資訊）
│     ├─ logs.js          ← GET /api/logs（站長查紀錄，要金鑰）
│     ├─ menu.js          ← GET /api/menu（公開：側邊欄選單；表空回預設）
│     ├─ settings.js      ← GET /api/settings（公開：站名＋Playground 全員開放與否）
│     ├─ articles/        ← GET /api/articles、/api/articles/12（公開：只回已發佈）
│     ├─ pages/           ← GET /api/pages、/api/pages/about（公開：只回已發佈）
│     └─ admin/           ← 站長 API（都要金鑰）：articles、pages 增刪改查、media 上傳、
│                            menu 覆蓋選單、settings 改站名/Playground 全員開關、apidoc 取 API 文件
└─ public/                ← 真正上網的檔案（只有這個資料夾會部署）
   ├─ index.html          ← 主站（☰ 側邊欄；選單由 /api/menu 動態載入）
   ├─ assets/logs.js      ← /logs 的頁面行為（外殼由 functions/logs.js 輸出）
   ├─ assets/admin.js     ← /admin 的頁面行為（外殼由 functions/admin.js 輸出）
   ├─ assets/marked.js    ← 後台/文件頁渲染 Markdown（與 lib/vendor 同版本 18.0.5）
   ├─ assets/adminbar.js  ← ✎ 編輯模式（只有登入過的裝置會載入；見「編輯模式」章節）
   ├─ robots.txt          ← 爬蟲規則＋sitemap 位置
   ├─ _headers            ← 靜態檔回應標頭（管理頁的 noindex 已改由頁面 meta 處理）
   └─ _redirects          ← （空）SPA 路由說明
```

## 部署（指令變了！）

```
npx wrangler pages deploy
```

**不要再加 `.`**（舊指令 `pages deploy .` 會把根目錄整包上傳，包含筆記與快取）。
wrangler.toml 已寫好專案名（uaip）與輸出資料夾（public），什麼參數都不用帶。
一樣不能用後台拖曳上傳（Functions 與 D1 綁定會消失）。

## 訪客紀錄

- 中介層 `functions/_middleware.js` 只記「頁面瀏覽」（/、/ip、/ua），
  不記 /api 與 /logs；瀏覽器 prefetch 也會跳過。寫入在背景執行、失敗不影響網站。
- 資料庫：D1 `ipua-logs`（ID 75e2b765-66fd-4946-99c4-4524b4149ce0，綁定名 `DB`）。
- 免費額度：每天 10 萬次寫入、500 萬次讀取、5 GB 容量 — 個人站用不完。

### 三個看紀錄的地方
1. **https://uaip.cc.cd/logs** — 自建管理頁（要管理金鑰），可搜尋、看統計、點列展開細節。
2. **Cloudflare 後台** → Storage & Databases → D1 → ipua-logs → Console，直接下 SQL：
   `SELECT * FROM visits ORDER BY id DESC LIMIT 50;`
3. 終端機：`npx wrangler d1 execute ipua-logs --remote -y --command "SELECT ..."`

### 管理金鑰（LOGS_TOKEN）
- **明文只放本機 `ADMIN.local.md`**（已 gitignore，絕不進版控）— 2026-07-14 起這份文件不再放金鑰本體。
  ⚠ 舊金鑰曾寫在這裡並已進 git 歷史：repo 公開前必須 `git filter-repo` 洗掉（記在 DEBT.md），
  且 v1.0.0 發佈流程已包含輪替一把新的。
- 設定／更換（跑完要再 `npx wrangler pages deploy` 一次才生效）：
  ```
  printf '<新金鑰>' | npx wrangler pages secret put LOGS_TOKEN --project-name uaip
  ```
  換完記得：① 新值先寫進 ADMIN.local.md　② 瀏覽器 /logs、/admin 頁重新輸入一次（localStorage 存的是舊的）。
- 金鑰沒設定時，正式站的紀錄 API 一律回 401（鎖死），本機開發（localhost）免金鑰。

### 維護 SQL（想清舊資料時）
```
-- 刪掉 180 天前的紀錄
DELETE FROM visits WHERE ts < datetime('now', '-180 days');
```

## 新聞／文章系統（2026-07-06 上線）

**發文流程**：網址列打 `uaip.cc.cd/admin` → 輸入管理金鑰（跟 /logs 同一把）→
「＋ 新增文章」→ 選分類（新聞/文章）、填標題摘要、上傳縮圖、寫內文 → 按「發佈」立即上線。
手機平板也能發文；「儲存草稿」的文章對外看不到。
**圖文穿插**（像 antutu 那樣）：內文每寫完一段，游標留在該段後面 → 按「插入圖片」，
圖就會插在那個位置；一篇建議 2～4 張、放在「講到它」的段落後面。

- 公開網址：`/news`（新聞列表）、`/articles`（文章列表）、`/news/12`（單篇，編號自動）。
  列表排版仿 antutu（左縮圖、右標題＋摘要＋時間/瀏覽數），設計沿用主站黑白極簡。
- 文章由伺服器輸出完整 HTML（含 og 分享卡、JSON-LD），Google 收錄與 LINE/FB 預覽都吃這個。
- **內文用 Markdown**：空一行＝分段、`## 小標`、`**粗體**`、`[文字](網址)`；按一次 Enter 就是換行
  （設了 breaks 模式，適合一般寫作）。後台下方有即時預覽，跟正式頁面同樣式。
- **圖片**：後台「上傳縮圖／插入圖片」→ 瀏覽器自動壓縮（最寬 1600px、webp）→ 存進 D1，
  網址是 `/img/編號`，由 Cloudflare 邊緣快取。單張壓縮後上限 1.8MB（D1 單值限 2MB）。
  也可以直接在縮圖欄貼外部圖片網址。
- 瀏覽數：文章頁每次真人瀏覽 +1（跳過 curl/bot/預抓）。留言功能目前沒做（2026-07 決定先不做）。
- **框架中英切換（2026-07-07 起）**：新聞/文章頁右上有 EN/中 鈕，跟主站共用同一個語言記憶
  （localStorage `ipua-lang`）；只翻「框架」（選單、時間、按鈕、頁尾），文章內容不翻譯。
  框架翻譯字典在 `lib/site.js` 的 SHELL_JS 裡（I18N 物件），加字串要 zh/en 一起補。
- 文章頁底部自動長出「上一篇／下一篇」（同分類、依發佈時間）；內文圖片自動 lazy 載入。
- RSS：`/feed`；sitemap：`/sitemap`（robots.txt 已指路）。
- 站名目前暫用網址 `uaip.cc.cd` — 想好名字後在右上角 ✎ →「⚙️ 網站名稱」直接改（免部署、立即生效）。
- 已知小事：cc.cd 的代理層會把 404 狀態改成 200（內容仍是「找不到內容」頁，且該頁 noindex，
  對 SEO 無實際影響；直連 uaip.pages.dev 是正常 404）。

## 編輯模式（✎）— 2026-07-09 上線

**在網站上直接改網站**，像手機整理桌面。只有「登入過後台的裝置」（瀏覽器 localStorage 有金鑰）
右上角才會出現 **✎** 按鈕（一般訪客連那支程式 `assets/adminbar.js` 都不會下載；真正的權限在伺服器端驗金鑰）。

按 ✎ 出現選單：

| 選項 | 做什麼 |
|---|---|
| ✏️ 編輯這篇文章 | 只在文章頁出現 — 一鍵跳進 `/admin?edit=這篇的編號` 直接改 |
| ＋ 新增文章 | 開後台編輯器寫新的（在 /articles 相關頁按，分類自動選「文章」） |
| ☰ 編輯選單 | 側邊欄變成編輯器：↑↓ 排順序、「改」改名/改網址、✕ 刪除、＋連結、＋分類、還原預設。**每個動作即時自動儲存**，按「✓ 完成」重新整理套用 |
| ⚙️ 網站名稱 | 改站名（分頁標題、分享卡、RSS 立即生效；**留空＝還原預設**）。不用再改程式了 |
| 📄/👣/📖 | 文章管理、訪客紀錄、API 文件的捷徑 |

- 選單與站名存在 D1（`menu`、`settings` 表）；**兩張表是空的時候自動用內建預設**（lib/site.js 的 DEFAULT_MENU／BRAND），所以「還原預設」＝清空資料表。
- 選單連結網址限「/開頭」或「http(s)://」；分類（section）是不能點的小標題，用來分組。
- 主站的 IP 查詢/UA 查詢連結（/ip、/ua）保持前端切換不重新載入；側邊欄「站長區」不在選單資料裡，是 adminbar 動態長的，編輯器裡看不到也不用管。

## 自訂頁面（/p/網址代稱）— 2026-07-09 上線

**用 API 就能幫網站開新頁面（新連結）**，不用改程式、不用部署。內容存 D1 `pages` 表，
公開網址 `/p/<slug>`（例 `/p/about`），外殼與文章頁同一套（側邊欄、日夜、SEO 標籤）。

- 建立：`POST /api/admin/pages`，本體 `{ slug, title, summary, body_md, status }`；
  slug 只能小寫英數與連字號、重複回 409；`status:"draft"` 對外看不到。
- 讀改刪：`GET/PUT/DELETE /api/admin/pages/<編號或slug>`；PUT 一樣**整包覆蓋**、可改 slug（＝搬網址）。
- 公開讀取：`GET /api/pages`、`GET /api/pages/<slug>`（只回已發佈）。
- 發佈後自動進 `/sitemap`；**不會自動進側邊欄** — 要入口就 ✎ →「編輯選單」加連結，
  或 `PUT /api/admin/menu` 加一條 `url:"/p/<slug>"`。
- 目前只有 API 能建立與編輯（網頁後台沒做頁面編輯器）；詳細範例見 /api-docs 或 agent skill。

## API（全功能都有；文件在 API.md）

**完整 API 文件＝專案根目錄的 [API.md](./API.md)**（GitHub 直接可讀）。線上版
<https://uaip.cc.cd/api-docs>（要管理金鑰）顯示的就是同一份 — 改 API.md 後跑
`node tools/build-apidoc.mjs` 重新產生 `lib/apidoc.js` 再部署（apidoc.js 是自動產生的，別手改）。
涵蓋：公開 API（whoami、已發佈文章/頁面列表與單篇、選單、站名）＋站長 API（文章與自訂頁面
增刪改查、圖片上傳、選單覆蓋、站名、訪客紀錄）。

**要交給 AI agent 操作時**：請 agent 讀根目錄 **[AGENTS.md](./AGENTS.md)**（操作指南＋鐵則＋
可照抄流程＋驗證清單）；用 Claude Code 開專案會透過 `.claude/skills/uaip-api` 自動導向同一份。
金鑰請 agent 讀這份 ADMIN.md（上面「管理金鑰」段落）。
**改任何 API 的同步清單**：`API.md` → 跑 build 腳本 → 必要時 `AGENTS.md` 的流程範例。

所有 `/api/admin/*` 與 `/api/logs` 都要帶標頭 `Authorization: Bearer <管理金鑰>`（上面那把 LOGS_TOKEN）。
最常用的「發文」長這樣：

```
# 1) 文章存成 UTF-8 的 art.json：
#    {"category":"news","status":"published","title":"標題","summary":"摘要",
#     "cover":"/img/5","body_md":"內文 Markdown"}
# 2) 發佈：
curl -X POST https://uaip.cc.cd/api/admin/articles ^
  -H "Authorization: Bearer 管理金鑰" ^
  -H "content-type: application/json; charset=utf-8" --data-binary @art.json
# 傳封面圖：
curl -X POST "https://uaip.cc.cd/api/admin/media?w=1200&h=675" ^
  -H "Authorization: Bearer 管理金鑰" -H "content-type: image/jpeg" --data-binary @cover.jpg
```

- **中文內容一定要走 `--data-binary @檔案`**：直接把中文寫在指令列，Windows 終端機會把編碼弄壞（Big5/UTF-8 打架，2026-07-06 實測踩過）。
- 圖片上限 1.8MB（D1 單值限 2MB），格式收 webp/jpeg/png/gif；後台網頁上傳會自動壓縮，走 API 要自己先縮好。
- 更新文章的 `PUT` 是**整包覆蓋**：先 GET 拿舊資料改完再 PUT，沒帶的欄位會被清空。
- 轉貼別站新聞的原則：**用自己的話改寫＋文末附資料來源連結**，不要整篇照抄（侵權，之後接廣告也會被判抄襲站）。

### ⚠️ 圖片編號絕不能重複使用

`/img/編號` 掛著「一年不變（immutable）」的邊緣快取，而 uaip.cc.cd 的快取清除權在 cc.cd 網域主手上、我們清不掉。所以：

- **不要**對 media/articles 執行 `DELETE FROM sqlite_sequence ...`（重設流水號）
- 刪過的圖片編號永遠作廢；**換圖＝上傳新編號、把文章 cover 改成新網址**
- 2026-07-07 踩過一次：重設流水號後新圖沿用舊編號 1，該節點的訪客看到的是快取裡的舊測試圖，最後把圖搬到新編號 /img/5 才解決

### 維護 SQL（文章系統）
```
-- 看全部文章（含草稿）
SELECT id,category,status,title,views FROM articles ORDER BY id DESC;
-- 找出「沒被縮圖也沒被內文引用」的孤兒圖片（先看清單，確認沒問題再手動 DELETE）
SELECT m.id, m.bytes, m.created_at FROM media m
WHERE NOT EXISTS (SELECT 1 FROM articles a
  WHERE a.cover = '/img/' || m.id OR a.body_md LIKE '%(/img/' || m.id || ')%');
-- 備份文章（在專案資料夾執行，匯出成 SQL 檔）
npx wrangler d1 export ipua-logs --remote --output backup.sql
```

## 本機測試

```
npx wrangler d1 execute ipua-logs --local --file db/schema.sql   # 第一次先建本機表
npx wrangler pages dev                                           # http://localhost:8788
```
本機（localhost）後台與 API 免金鑰，方便試寫；本機資料庫與正式站完全分開，隨便玩不影響線上。

## 主題（日夜）

右上角一顆按鈕，點一下循環三種模式，**選擇會記住**（存瀏覽器 localStorage `ipua-theme-mode`，跨頁面、跨次瀏覽都保留）：

- **☀ 白天**＝白底（**新訪客的預設**）
- **☾ 夜間**＝黑底
- **🌓 自動**＝依訪客所在地的日夜自動切換（白天用 IP 定位算太陽高度，未定位前用裝置時鐘 6–18 點當白天）

全站共用同一套與同一個記憶鍵。要改預設或圖示只有**兩處**：主站在 `public/index.html`、
其他所有頁面（新聞/文章、/p/頁面、/logs、/admin、/api-docs）都吃 `lib/site.js` 的 SHELL_JS，
**兩處要一起改**（2026-07-09 起 /logs、/admin 改用共用外殼，不再各養一份）。

## 側邊欄

主站「螢幕最左上角」固定一顆 ☰（捲動時也在）。**2026-07-09 起選單存在 D1（menu 表）**：
要加分類/連結、改順序 → 右上角 ✎ →「編輯選單」直接在網頁上改（見「編輯模式」章節），
或程式化 `PUT /api/admin/menu`（見 /api-docs），**不用再改程式碼**。
menu 表空＝用內建預設（lib/site.js 的 DEFAULT_MENU；index.html 也留了一份靜態預設當載入前的底）。

**「訪客紀錄」入口一般訪客看不到**：選單 HTML 裡沒有這個連結，
只有「這台裝置成功登入過 /logs」（瀏覽器 localStorage 存有金鑰）才會動態長出「站長 → 訪客紀錄」。
所以站長的進入方式＝直接在網址列打 `uaip.cc.cd/logs` 輸入金鑰；登入過一次，之後選單就有捷徑。
在 /logs 按「清除金鑰」捷徑就會消失。就算有人翻原始碼猜到 /logs，沒金鑰 API 一律回 401。

## Google 登入 ＋ 會員系統（2026-07-11 上線）

任何人都能用 Google 登入成為「會員」；會員功能（**API 中轉站** /relay、**VPN 訂閱** /vpn）要**站長核准**後才生效。站長信箱登入後自動是管理員，管理頁與站長 API 免金鑰（金鑰仍可用，給 curl／agent）。右上角是「帳號」鈕（登入／頭像下拉）；站長的編輯工具從舊的右上角 ✎ **搬進 ☰ 側邊欄「站長」區**了。

**VPN 隱形（2026-07-14 v1.0.0）**：非站長且未被批准 vpn 服務的人**完全看不到 VPN 的存在** —
側邊欄選單不渲染、`/vpn` 回靜態 SPA（跟打不存在的路徑一樣）、`/api/me` 不吐 vpn 欄位、
頭像下拉也沒有 VPN 項。**必然代價**：已被批准但「還沒登入」的會員打 /vpn 一樣看到 SPA —
請他先登入、再從頭像選單進 VPN。`/vpn/sub/<token>` 訂閱端點不受影響（token 即驗證）。

### 資料表（都在同一個 D1 `ipua-logs`）
- `users`：會員（google_sub、email、status=pending/approved/blocked、is_admin、api_key_hash＝中轉金鑰的 SHA-256、vpn_token＝訂閱代碼、用量）。
- `sessions`：登入狀態（cookie `ipua_sess` 存的是 SHA-256）。
- `relay_channels`：中轉上游管道（slug、kind、base_url、api_key）。
- `vpn_channels`：VPN 上游渠道（name、kind=sub/nodes、url、nodes、enabled）。2026-07-12 起多渠道，取代舊的 settings.vpn_source。

### 要設的環境變數（secrets）
```
# 1) 站長信箱（逗號分隔，可多個）。沒設就用程式內建預設 zwwe1f@gmail.com。
printf 'zwwe1f@gmail.com' | npx wrangler pages secret put ADMIN_EMAILS --project-name uaip

# 2) Google OAuth 憑證（申請步驟見下）：
printf '你的CLIENT_ID' | npx wrangler pages secret put GOOGLE_CLIENT_ID --project-name uaip
printf '你的CLIENT_SECRET' | npx wrangler pages secret put GOOGLE_CLIENT_SECRET --project-name uaip
# 設完要重新 npx wrangler pages deploy 一次才生效。
```
沒設 GOOGLE_CLIENT_ID 時：正式站 /auth/login 顯示「尚未開通」；本機（localhost）會改用「輸入信箱就登入」的測試表單，不需 Google 憑證也能開發測試。

### 申請 Google OAuth 憑證（一次性，約 5 分鐘）
1. 開 <https://console.cloud.google.com/> → 建一個專案（例 uaip）。
2. 左側「APIs & Services」→「OAuth consent screen」：User Type 選 **External**、填 App 名稱與你的信箱、Scopes 只要 `email`/`profile`/`openid`；發佈狀態 Testing 就夠（要用的人先加進 Test users，或按 Publish 讓任何人都能登入）。
3.「Credentials」→ Create Credentials →「OAuth client ID」→ Application type **Web application**。
4. **Authorized redirect URIs** 填這兩個（一定要完全一致）：
   - `https://uaip.cc.cd/auth/callback`
   - `https://uaip.pages.dev/auth/callback`（備用網域，可省）
   - 本機測試不用登記（localhost 走測試表單）。
5. 建好後把 **Client ID** 與 **Client secret** 用上面的指令設進 Cloudflare。
- 之後要多開放誰：把對方信箱加進 OAuth consent screen 的 Test users（或已 Publish 就不用）；要升成站長就在 /members 頁按「設為站長」，或把信箱加進 ADMIN_EMAILS。

### 日常操作
- **核准會員**：/members 頁（站長）→ 待核准清單按「核准」。或 API：`PUT /api/admin/users/{id} {"action":"approve"}`。
- **加中轉管道**：/relay 頁（站長）「管道管理」→ 新增。**選類型（OpenAI／Anthropic／Gemini）會自動帶入官方 Base URL**，用便宜的第三方渠道就把網址改成他家的、金鑰填他給的（你手打過的網址不會被自動蓋掉）。之後會員用自己的 `uak-` 金鑰 + Base URL `https://uaip.cc.cd/relay/<slug>` 就能打。**每找到一個渠道就加一個**，暫時不想用就按「停用」（留著不刪）。
  - ✅ **2026-07-12 已上線 Gemini 官方渠道**（slug `gemini`），正式站實測會員視角可用：Gemini SDK（`x-goog-api-key`）、OpenAI SDK（`/relay/gemini/v1beta/openai` + `Authorization: Bearer`）、串流三種都通。
- **加 VPN 渠道**：/vpn 頁（站長）「渠道管理」→ 新增，貼機場訂閱網址（kind=sub）或自己的節點連結（kind=nodes）。**會員的訂閱網址永遠是同一條**，伺服器自動把所有啟用中渠道的節點合併給他們。
- 護欄：站長不能在網頁上封鎖／刪除自己，也動不了 ADMIN_EMAILS 指定的帳號（要改就改環境變數）。

### 兩個「中轉」的運作方式（2026-07-12 完成）

核心概念一樣：**站長保管真正的上游（網址＋金鑰），會員只拿到一把我方發的憑證**，所有流量經 Cloudflare 轉一手，會員看不到也偷不走上游。

| | API 中轉站 /relay | VPN /vpn |
|---|---|---|
| 站長新增的東西 | 管道：base_url ＋ 該平台 API Key ＋ slug | 渠道：機場訂閱網址，或手動節點清單 |
| 會員拿到的憑證 | 自己的 `uak-` 金鑰（在 /relay 按「產生」） | 自己的 `/vpn/sub/<token>` 訂閱網址 |
| 會員怎麼用 | Base URL 換成 `https://uaip.cc.cd/relay/<slug>`、API Key 填 `uak-…` | 訂閱網址貼進 Clash／v2rayN／Shadowrocket |
| 會員看得到什麼 | 管道的**名稱**與類型（挑要用哪個），看不到 base_url 與上游金鑰 | 只有節點，**完全看不到渠道與上游網址** |
| 多渠道怎麼選 | 會員自己選：一個管道一個網址（`/relay/a`、`/relay/b`） | 不用選：所有啟用中渠道的節點自動合併去重成一份 |
| 未核准的人 | 401／403（金鑰無效或帳號未核准） | 403（訂閱抓不到東西） |

- **VPN 多渠道的格式眉角**：只啟用「一個」訂閱渠道時＝原樣轉發（機場的 Clash YAML、流量／到期資訊都保留）；啟用「兩個以上」時，伺服器改抓 base64 節點清單合併（Clash YAML 沒法安全合併會被略過，流量資訊也無法合併）。想保留流量顯示就只開那一個機場。
- **中轉的驗證頭眉角（2026-07-12 實測踩到）**：金鑰要放哪個標頭是**看路徑**、不是只看 kind。各家的「OpenAI 相容層」（路徑含 `/openai/` 或結尾 `chat/completions`）一律收 `Authorization: Bearer`；原生介面才用自家標頭（Anthropic `x-api-key`、Gemini `x-goog-api-key`）。**Gemini 原生端點多送一個 `Authorization` 就會 401**（Google 當成 OAuth token），所以只能二選一。
- 會員的用量（`relay_calls` 中轉次數、`vpn_pulls` 訂閱抓取次數）在 /members 頁看得到。
- 上游金鑰／訂閱網址在站長 API 回讀時一律**遮罩**（只回開頭…結尾），要換就直接重填；編輯時該欄留空＝保留舊值。

## 廣告計畫

> 目標：加**非侵入式**廣告（明確不要彈窗／popunder／插頁）。2026-07-02 定路線：**Adsterra 先上車＋A-ADS 先體驗**，暫不買網域。

- **AdSense 已排除**：2023-03 起 AdSense 只收「根網域」，uaip.cc.cd 的根網域 `cc.cd` 不是自己的 → 除非買自有網域（Cloudflare Registrar 約 US$10/年），否則進不去。目前選擇先不花錢。
- **版位已內建（2026-07-02，通用空殼，正式站空的時候隱形）**：
  - `#ad-side` 300×250，固定右下角，只在螢幕 **≥1400px** 顯示（斷點算過：保證與內容至少留 24px 間距）。
  - `#ad-bottom` ≤336px，置中、頁尾前，只在 **<1400px** 顯示。
  - 兩者互斥（同一時間只出現一個）；用 `:not(:empty)` 讓「空版位」不佔高度。
  - 在 localhost 開發時，body 會加 `ad-dev` class，顯示虛線預覽框，方便看版位位置。
- **A-ADS 已上線（2026-07-02）**：廣告單元編號 **2446505**（300×250）。程式 `initAds()` 建一個 iframe，只掛進「當前可見」的版位（用 `matchMedia(1400px)` 判斷，螢幕縮放時搬移）。新單元初期會顯示「Advertise In This Ad Space」佔位圖，屬正常。**A-ADS 的管理連結要自己保存好**。
- **待辦：接 Adsterra**
  1. 去 Adsterra 註冊 **Publisher（發布商）**帳號，格式**只開 Banner**（不要彈窗類）。
  2. 建兩個 **300×250** 廣告單元。
  3. 把代碼交給 Claude 接上（屆時取代或與 A-ADS 並存）。
  - **接 Adsterra 的技術眉角**：它的 banner 代碼含 `document.write`，**必須直接寫在 HTML 裡**（不能等網頁載入後再用 JS 注入，否則會清空整頁）；一樣用 `matchMedia` 判斷，只對「當前可見」的版位輸出代碼。
- **規矩提醒**：**不可以自己點自己的廣告**（會被封）；廣告旁的標籤文字只能寫「廣告」。

## 在別台電腦／新環境部署的備忘

- `wrangler login` 是 OAuth（開瀏覽器授權）。這台電腦已登入過，憑證存在本機。**換新電腦要重跑一次 `npx wrangler login`。**
- 眉角：預設瀏覽器是 Edge，但 Cloudflare 帳號是登入在 **Chrome**。所以登入時要用
  `npx wrangler login --browser=false` 讓它印出網址，再**自己複製到 Chrome 開**，才會對到正確帳號。
- 同一個 Cloudflare 帳號裡還有另一個 Pages 專案 `admin`（網址 cfwe.cc.cd），別搞混。
- 曾遇到：家中 WiFi 連不到部分第三方服務（例：httpbin.org 逾時）。網站已改用「同源 API」避開這個問題，所以不受影響。

