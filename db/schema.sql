-- 訪客紀錄資料表：functions/_middleware.js 每次頁面瀏覽寫入一列。
-- 套用方式（可重複執行，IF NOT EXISTS 不會蓋掉既有資料）：
--   本機測試庫：npx wrangler d1 execute ipua-logs --local  --file db/schema.sql
--   正式庫　　：npx wrangler d1 execute ipua-logs --remote --file db/schema.sql
CREATE TABLE IF NOT EXISTS visits (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      TEXT NOT NULL,   -- UTC ISO 時間（顯示時由管理頁轉成本地時間）
  host    TEXT,            -- uaip.cc.cd 或 uaip.pages.dev
  path    TEXT,
  method  TEXT,
  ip      TEXT,
  ua      TEXT,
  country TEXT,
  city    TEXT,
  region  TEXT,
  colo    TEXT,            -- 訪客連到的 Cloudflare 節點（例：TPE）
  asn     INTEGER,
  isp     TEXT,
  lang    TEXT,            -- Accept-Language 標頭
  referer TEXT,
  http    TEXT,            -- HTTP 協定版本
  tls     TEXT             -- TLS 版本
);
CREATE INDEX IF NOT EXISTS idx_visits_ts ON visits (ts);
CREATE INDEX IF NOT EXISTS idx_visits_ip ON visits (ip);

-- 文章（新聞／文章共用一張表，category 區分）：/admin 後台寫入，/news、/articles 讀出。
CREATE TABLE IF NOT EXISTS articles (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  category     TEXT NOT NULL DEFAULT 'news',   -- 'news'（新聞）或 'article'（文章）
  title        TEXT NOT NULL,
  summary      TEXT NOT NULL DEFAULT '',       -- 列表顯示的兩行摘要，也是 SEO 描述
  cover        TEXT NOT NULL DEFAULT '',       -- 縮圖網址（通常是 /img/編號，也可貼外部網址）
  body_md      TEXT NOT NULL DEFAULT '',       -- 內文（Markdown 原稿；顯示時由伺服器轉 HTML）
  status       TEXT NOT NULL DEFAULT 'draft',  -- 'draft'（草稿）或 'published'（已發佈）
  views        INTEGER NOT NULL DEFAULT 0,     -- 瀏覽數（文章頁每次真人瀏覽 +1）
  created_at   TEXT NOT NULL,                  -- UTC ISO
  updated_at   TEXT NOT NULL,
  published_at TEXT                            -- 第一次發佈的時間（列表排序、RSS 用；再編輯不變）
);
CREATE INDEX IF NOT EXISTS idx_articles_list ON articles (status, category, published_at DESC);

-- 圖片（縮圖與文中配圖）：後台上傳前先在瀏覽器壓縮，存進 D1，由 /img/編號 讀出並快取。
CREATE TABLE IF NOT EXISTS media (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  mime       TEXT NOT NULL,        -- image/webp、image/jpeg…
  bytes      INTEGER NOT NULL,     -- 檔案大小（上限約 1.8MB，D1 單值限制 2MB）
  w          INTEGER, h INTEGER,   -- 像素尺寸（後台顯示用）
  data       BLOB NOT NULL,
  created_at TEXT NOT NULL
);

-- 側邊欄選單（2026-07-09 編輯模式上線）：站長在網頁上就能加分類/連結、排順序。
-- 表是「整份選單由上到下」的平面清單：kind='section' 是分類標題、'link' 是連結，依 pos 排序。
-- 表空的時候網站自動用內建預設選單（lib/site.js 的 DEFAULT_MENU）；
-- 寫入走 PUT /api/admin/menu（整包覆蓋），傳空陣列＝清空＝還原預設。
CREATE TABLE IF NOT EXISTS menu (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  pos      INTEGER NOT NULL DEFAULT 0,   -- 顯示順序（小的在上面）
  kind     TEXT NOT NULL DEFAULT 'link', -- 'section'（分類標題）或 'link'（連結）
  label    TEXT NOT NULL,                -- 中文名稱
  label_en TEXT NOT NULL DEFAULT '',     -- 英文名稱（空＝顯示中文）
  url      TEXT NOT NULL DEFAULT ''      -- 連結網址（section 留空；限 / 開頭或 http(s)://）
);

-- 自訂頁面（2026-07-09 上線）：站長／agent 用 API 就能開新頁面，公開網址 /p/<slug>。
-- 例：slug='about' → https://uaip.cc.cd/p/about。想放進側邊欄 → PUT /api/admin/menu 加連結。
-- 寫入走 /api/admin/pages（CRUD）；公開讀取走 /api/pages。draft（草稿）對外看不到。
CREATE TABLE IF NOT EXISTS pages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  slug       TEXT NOT NULL UNIQUE,           -- 網址代稱：小寫英數與連字號，例 about、privacy-policy
  title      TEXT NOT NULL,
  summary    TEXT NOT NULL DEFAULT '',       -- meta description（SEO／分享卡描述）
  body_md    TEXT NOT NULL DEFAULT '',       -- 內文（Markdown 原稿；顯示時由伺服器轉 HTML）
  status     TEXT NOT NULL DEFAULT 'draft',  -- 'draft'（草稿）或 'published'（已發佈）
  created_at TEXT NOT NULL,                  -- UTC ISO
  updated_at TEXT NOT NULL
);

-- 網站設定（key-value）：brand（站名）。表空或沒該鍵時用程式內建預設。
-- 寫入走 PUT /api/admin/settings（brand）。（VPN 來源 2026-07-12 起搬到 vpn_channels 表。）
CREATE TABLE IF NOT EXISTS settings (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

-- 會員（2026-07-11 Google 登入上線）：任何人都能用 Google 登入，但 status 要站長核准（approved）
-- 之後，API 中轉與 VPN 訂閱才真的能用。站長信箱（lib/auth.js ADMIN_EMAILS_DEFAULT 或環境變數
-- ADMIN_EMAILS）第一次登入自動 approved＋is_admin=1。
CREATE TABLE IF NOT EXISTS users (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  google_sub   TEXT NOT NULL UNIQUE,          -- Google 帳號的永久編號（本機測試登入是 dev:信箱）
  email        TEXT NOT NULL,
  name         TEXT NOT NULL DEFAULT '',
  picture      TEXT NOT NULL DEFAULT '',      -- Google 大頭貼網址
  status       TEXT NOT NULL DEFAULT 'pending', -- pending（待核准）/ approved（已核准）/ blocked（封鎖）
  is_admin     INTEGER NOT NULL DEFAULT 0,
  api_key_hash TEXT NOT NULL DEFAULT '',      -- 會員 API 金鑰（uak-…）的 SHA-256；空字串＝還沒產生
  api_key_hint TEXT NOT NULL DEFAULT '',      -- 顯示用提示（開頭…結尾），明文金鑰不落地
  api_key_at   TEXT,                          -- 金鑰產生時間（UTC ISO）
  vpn_token    TEXT NOT NULL DEFAULT '',      -- VPN 訂閱網址代碼（/vpn/sub/<token>），可重生
  relay_calls  INTEGER NOT NULL DEFAULT 0,    -- 中轉累計請求數
  vpn_pulls    INTEGER NOT NULL DEFAULT 0,    -- 訂閱被抓取次數
  created_at   TEXT NOT NULL,
  last_login   TEXT
);
CREATE INDEX IF NOT EXISTS idx_users_key ON users (api_key_hash);
CREATE INDEX IF NOT EXISTS idx_users_vpn ON users (vpn_token);

-- 登入狀態（HttpOnly cookie ipua_sess ↔ 這張表）：sid 存的是 SHA-256 雜湊，
-- 資料庫外洩也拿不到能用的 cookie。過期列在每次登入時順手清掉。
CREATE TABLE IF NOT EXISTS sessions (
  sid        TEXT PRIMARY KEY,   -- cookie 值的 SHA-256
  user_id    INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_exp ON sessions (expires_at);

-- VPN 訂閱的上游渠道（2026-07-12 多渠道化，取代舊 settings 的 vpn_source/vpn_nodes）：
-- 站長在 /vpn 管理，會員的 /vpn/sub/<token> 會把「所有啟用中渠道」的節點合併送出，
-- 會員看不到渠道存在與上游網址。kind='sub' 是機場訂閱網址、'nodes' 是手動貼的節點清單。
CREATE TABLE IF NOT EXISTS vpn_channels (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,                  -- 顯示名稱（只有站長看得到，例：某機場 3 元月付）
  kind       TEXT NOT NULL DEFAULT 'sub',    -- 'sub'（上游訂閱網址）或 'nodes'（手動節點）
  url        TEXT NOT NULL DEFAULT '',       -- kind='sub' 用：上游訂閱網址（站長 API 回讀一律遮罩）
  nodes      TEXT NOT NULL DEFAULT '',       -- kind='nodes' 用：一行一條 vmess:// vless:// …
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

-- API 中轉站的上游管道（2026-07-11）：站長在 /relay 管理。會員打 /relay/<slug>/...，
-- 伺服器把驗證換成這裡存的上游金鑰後轉發。kind 決定上游收金鑰的方式：
-- openai/custom → Authorization: Bearer；anthropic → x-api-key；gemini → x-goog-api-key。
CREATE TABLE IF NOT EXISTS relay_channels (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  slug       TEXT NOT NULL UNIQUE,            -- 網址代稱（小寫英數與連字號），例 openai、my-ollama
  name       TEXT NOT NULL,                   -- 顯示名稱
  kind       TEXT NOT NULL DEFAULT 'openai',  -- openai / anthropic / gemini / custom
  base_url   TEXT NOT NULL,                   -- 上游根網址，例 https://api.openai.com
  api_key    TEXT NOT NULL DEFAULT '',        -- 上游金鑰（只有站長 API 摸得到，回讀一律遮罩）
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
