# Threat Model / 威脅模型

> STRIDE analysis of every trust boundary in uaip.cc.cd (v2.0.0, 2026-07).
> English first; 繁體中文在後半。Scope: the Cloudflare Workers app (worker + D1 + static assets).
> Out of scope: Cloudflare platform itself, Google OAuth infrastructure, upstream LLM/VPN providers' internals.

## 1. System sketch

```
Browser ──(HTTPS)── Cloudflare Workers
  ├─ static SPA (/, /ip, /ua)            ← _headers CSP (sha256)
  ├─ SSR pages via src/lib/site.ts html() ← per-request nonce CSP
  └─ Worker routes (src/routes/)
      ├─ /auth/*        Google OAuth code flow, HttpOnly session cookie (sid hashed in D1)
      ├─ /api/*         member APIs (cookie + Origin check) / admin APIs (Bearer LOGS_TOKEN or admin cookie)
      ├─ /relay/*       LLM gateway: member key (uak-) → upstream key swap, streaming passthrough
      └─ /vpn/sub/*     subscription mirror: capability token in URL
D1 (single database): users, sessions, req_log, errlog, audit_log, content tables
Secrets: GOOGLE_CLIENT_ID/SECRET, ADMIN_EMAILS, LOGS_TOKEN (wrangler secrets)
```

## 2. Entry points × STRIDE

### 2.1 Google OAuth (`/auth/login`, `/auth/callback`)
| Threat | Analysis | Mitigation |
|---|---|---|
| **S**poofing | Forged callback / CSRF login | `state` random value pinned in HttpOnly cookie, 10-min lifetime; `redirect_uri` fixed to own origin; `aud` claim must equal our client id |
| **T**ampering | Modified id_token | Token obtained server-to-server over TLS directly from Google (no signature check needed for direct exchange); `email_verified` enforced |
| **R**epudiation | — | Login failures recorded to errlog (`oauth.callback`) |
| **I**nfo disclosure | Secrets in code | CLIENT_SECRET only in wrangler secret; never logged |
| **D**oS | Login flood | Cloudflare edge absorbs; no unauthenticated D1 writes in login path until token verified |
| **E**levation | Anyone becomes admin | Admin only via `ADMIN_EMAILS` (env) match; web UI cannot promote to the root admin set |

### 2.2 Session cookie (`ipua_sess`)
- HttpOnly + Secure + SameSite=Lax; value is 160-bit random base32.
- **D1 stores only the SHA-256 of the sid** — a database leak yields no usable cookies.
- Expiry enforced on read; expired rows purged on each login; `revoke_sessions` (admin) and `/api/account/logout-all` (self) invalidate all devices.
- CSRF: all state-changing cookie-authenticated endpoints check the `Origin` header (`goodOrigin`), allowing only own origins; `Origin: null` rejected.

### 2.3 Member API key (`uak-…`, relay)
- Displayed once at generation; D1 stores SHA-256 + display hint only.
- Format-checked (`^uak-[a-z2-7]{16,64}$`) before any DB lookup (cheap reject).
- Key accepted from Authorization/x-api-key/x-goog-api-key/?key= — all four locations are **stripped** before forwarding upstream (DROP list) and `?key=` deleted from the query string.
- Compromise blast radius: relay only, capped by per-user daily quota + rate limit; owner regenerates key (old hash dead instantly).

### 2.4 Relay passthrough (`/relay/{slug}/…`)
| Threat | Analysis | Mitigation |
|---|---|---|
| Spoofing | Using service without approval | uak- key → user row → `hasService(relay)`; blocked/pending → 403 |
| Tampering | Header smuggling to upstream | DROP regex strips connection/CF/identity headers; path segments re-encoded (`encodeURIComponent`, `:`/`@` preserved for Gemini) |
| Repudiation | "I never made those calls" | req_log row per request (user, channel, model, status, latency, tokens) |
| Info disclosure | Upstream identity/keys leaking to member | Upstream key never echoed; `set-cookie` stripped from responses; upstream error bodies pass through **as-is by design** (member-facing relay is transparent) — upstream base_url is admin-only data |
| Info disclosure | Member request bodies | Metering scans the **response** tail only; request bodies are never buffered or parsed |
| DoS / cost burn | Member floods paid upstream | Daily quota + rolling 60s rate limit (429 + Retry-After); admin exempt; client disconnect cancels the upstream read (pump, not tee) |
| Elevation | slug traversal to other origins | Target = channel.base_url (admin-configured) + re-encoded path; no user-controlled host |

### 2.5 VPN subscription (`/vpn/sub/{token}`)
- Capability token in URL (uvt-…) — inherent trade-off for VPN-app compatibility (apps can't send cookies). Token is regenerable; format-checked; blocked/pending users rejected even with valid token.
- Upstream airport URLs never appear in responses; multi-channel merge returns node lists only.
- v1.0.0: `/vpn` page is **invisible** to anyone without the vpn service (menu filtered, page serves the SPA shell, `/api/me` omits vpn fields) — see ADR-0003/plan Phase F.
- Rate: edge cache 5 min per upstream; per-user `vpn_pulls` counter.

### 2.6 Admin API (`/api/admin/*`, `/api/logs`)
- Two identities: `Bearer LOGS_TOKEN` (curl/agents) or admin session cookie (browser, Origin-checked).
- LOGS_TOKEN plaintext lives only in gitignored ADMIN.local.md; rotated at v1.0.0 release. Old value exists in git history → **must** filter-repo before the repo ever goes public (DEBT).
- Every mutation writes audit_log (actor, action, target, summary); summaries never contain secrets (channel keys/URLs recorded as presence only).
- Root-admin accounts (ADMIN_EMAILS) cannot be blocked/demoted/deleted from the web; self-lockout guards.

### 2.7 SSE streaming (playground `/api/playground/chat`)
- Upstream errors are sanitized for members (provider identity hidden); admins see raw detail.
- Client abort → upstream reader cancelled (no orphaned paid generation).
- Persistence failures logged (`pg.persist`); partial responses saved.
- Output rendered client-side with marked + a DOM sanitizer (script/style/iframe stripped, `on*` attributes and js: URLs removed); the chat area is script-free content, so a malicious upstream injecting HTML gets no nonce and is blocked by CSP.

### 2.7b Anonymous demo mode (v2.0.0, ADR-0009)
- Attack surface: unauthenticated `POST /api/playground/chat` pointed at a paid upstream.
- Channel lock is checked **before** any DB lookup (no channel-slug probing); model allowlist; 4k input chars; optional per-reply `max_tokens` cap (`demo_max_tokens`, unset by default since 2026-07-21).
- Double **fail-closed** rate limit in the RateLimiter DO (per-IP minute/day + site-wide day); DO failure → 503, never allow — the inverse of the member path's fail-open, deliberately.
- Conversations and accounting both go to a synthetic `demo:public` user row that can never log in. Visitors have **no read path** (list/read/delete all run `pgUser` → 401 for anonymous, own-`user_id` for members), so no visitor can read their own or another visitor's demo chat; only the admin log shows them.
- Worst-case daily burn is bounded by `demo_global_day ×` the per-reply cap; with `demo_max_tokens` unset the request-count half is the whole backstop (it is the half that always held anyway). One settings write kills the surface without a deploy.

### 2.8 D1 (single database)
- All queries use bound parameters (no string-built SQL with user input; LIMIT/OFFSET are parseInt-validated).
- Media BLOBs capped at 1.8 MB; text columns length-clamped at write time.
- Observability writes (req_log/errlog/audit_log) are fire-and-forget and never fail the request.
- Backups: daily cron exports every table as JSONL to a private R2 bucket (media BLOBs excluded, 14 copies retained, src/cron.ts); manual `wrangler d1 export` remains as a second line (see ADMIN.md).

### 2.9 Browser surface (XSS / clickjacking / MIME)
- **Stored-XSS via markdown (fixed v2.0.0):** admin-authored article/page markdown is rendered server-side with `marked`, which passes **raw embedded HTML through verbatim**. A stolen admin token (or a future lower-privilege author role) could store `<script>`/`onerror=` in a post. Two independent defenses now stand between content and execution:
  1. **Whitelist sanitizer** (`src/lib/sanitize.ts`, zero-dep, ~130 lines) runs on every `marked.parse()` output — SSR article/page bodies and the `?html=1` APIs. Tag whitelist, per-tag attribute whitelist (drops `on*`/`style`), dangerous containers (`script`/`style`/`iframe`/`svg`/…) dropped with their contents, and href/src scheme whitelist with entity-decoding + control-char stripping (blocks `javascript:`, `data:text/html`, `&#106;avascript:`, `java\tscript:`).
  2. **Nonce marking (not blanket stamping):** `html()` now stamps the per-request nonce **only on shell-authored `<script data-nonce>` tags**, not on every `<script>` in the body. Any script that reaches the body from content has no nonce → blocked by `script-src 'self' 'nonce-…'`. This is the load-bearing control even if the sanitizer ever misses something.
- Static SPA: CSP with sha256 of the single inline script (drift-checked in CI by tools/check-csp.mjs).
- `style-src 'unsafe-inline'` retained (large inline-style surface, DEBT); zero inline `on*=` handlers site-wide (audited).
- All user/content interpolation goes through `esc()`; only markdown bodies allow HTML, and those are sanitized as above.
- `frame-ancestors 'none'`, `nosniff`, HSTS, COOP on every SSR response; CSP violations reported to `/api/csp-report` (10% sampled → errlog).

## 3. Non-goals / accepted risks
- No WAF rules beyond Cloudflare defaults; no bot management.
- VPN token-in-URL can leak via shoulder-surfing/history — mitigated by regeneration, accepted for app compatibility.
- Upstream providers see relayed request contents (inherent to a relay).
- Single D1 region; availability bound to Cloudflare.

## 4. Known accepted risks — stated, not fixed (2026-07-22)

The list above is the short form. These four are written out because each is a real
weakness that a reader could find, and "we didn't notice" and "we decided" look identical
from the outside unless the decision is written down. Each says what is traded for what,
and **what would change the decision** — a risk without a reversal condition is just an
excuse.

### 4.1 `goodOrigin` accepts a localhost `Origin` on the production site

`auth.ts:237` allows `http://localhost:*` and `http://127.0.0.1:*` as CSRF origins
regardless of the deployment. `test/unit/auth.test.ts` pins this as intended, so it is a
decision, not an accident.

**The risk is real but narrow**: an attacker must get a logged-in *admin* to load a page
they control **on the admin's own loopback interface** — a local dev server, a running
Electron app, a locally-served HTML file with a listener. That is a meaningfully harder
precondition than a normal CSRF, but it is not impossible for a developer's machine, which
is exactly the population that has admin cookies here.

**What it buys**: developing against the production API from `wrangler dev` without
maintaining a second origin allowlist.
**Not fixed because** the maintainer is the only admin and does that regularly.
**Reversal condition**: a second admin account exists, or admin cookies are ever held by
someone who is not the developer. At that point the loopback exception should be gated on
`isDevEnv(env)` like the `adminOk` bypass already is (see §4.4).

### 4.2 Daily R2 backups contain plaintext secrets

`cron.ts:91-108` backs up `relay_channels`, `users`, `settings` and `vpn_channels` with
`cols: "*"`. So each daily JSONL contains **upstream API keys in plaintext, the Telegram
bot token, and every member's VPN token** — and 14 copies are retained.

**This is not a code bug.** The keys must be plaintext in D1 for the relay to forward at
all (ADR-0003), so a faithful backup necessarily contains them. What makes it worth
recording is the *blast-radius shift*: `media.data` was carefully excluded for CPU
reasons, which shows the column list was thought about — but only for size, never for
sensitivity. The result is 14 rolling copies of every credential in the system sitting in
a **different storage product with a different access-control surface** from the one the
threat model actually reasons about.

**Reversal condition**: anyone other than the maintainer gains R2 read access. The cheaper
partial fix — redacting secret columns at backup time — has a real cost: the backup stops
being restorable into a working system, which is most of why it exists. (DEBT #20)

### 4.3 `vpn_token` is stored in plaintext

`0001_baseline.sql:103`. In the same table, `sessions.sid` and `api_key_hash` are both
hashed, and the schema comment explains why. `vpn_token` is equally a bearer credential
and is not. Lookups are exact-match, so hashing works with no query changes and the index
still applies — this is cheap, it simply hasn't been done.

**Combined with §4.2, one R2 backup is every member's VPN subscription.** That
combination, not either item alone, is the reason both are written here.
**Reversal condition**: the next migration that touches `users` (DEBT #21).

### 4.4 Correction to §2.4 — path re-encoding is not traversal protection

§2.4 claims path segments are "re-encoded (`encodeURIComponent`)" as a tampering
mitigation. That is **imprecise as stated**: `encodeURIComponent` does not escape `.`, so
`.` and `..` survive re-encoding (`relay/[[path]].ts:83-86`).

It is not currently exploitable — the host comes from the admin-configured `base_url` and
is never user-controlled, so the worst case is reaching a different path *on an upstream
the admin already authorized*. It becomes a real issue the moment a channel's `base_url`
carries a path prefix (`https://host/api/v1`), because `..` could then climb out of that
prefix. Tracked as DEBT #22; the fix is to reject segments equal to `.` or `..`.

---

# 繁體中文版

> 對 uaip.cc.cd（v2.0.0）每一條信任邊界做 STRIDE 分析。
> 範圍：Cloudflare Workers 應用本體（worker＋D1＋靜態資產）；
> 不含 Cloudflare 平台、Google OAuth 基礎設施、上游 LLM／機場的內部。

## 入口 × 威脅重點

**Google OAuth**：`state` 亂數綁 HttpOnly cookie（10 分鐘）防 CSRF 登入；token 由伺服器直連
Google 交換（TLS、來源可信）；`aud` 必須是自己的 client id；`email_verified` 必須為真；
管理員身分只認 `ADMIN_EMAILS` 環境變數，網頁上動不了。登入失敗進站內錯誤日誌。

**Session cookie**：HttpOnly＋Secure＋SameSite=Lax；**資料庫只存 sid 的 SHA-256** —
資料庫外洩拿不到能用的 cookie。過期即失效；管理員可 `revoke_sessions` 踢人、
會員可 `/api/account/logout-all` 自救。所有 cookie 身分的寫入端點都驗 `Origin`。

**會員金鑰（uak-）**：產生當下顯示一次，庫內只有雜湊＋提示；先過格式檢查再查庫；
四個擺放位置在轉發前全部剝除、`?key=` 從查詢字串刪掉。外洩影響面＝relay 一項，
且被日配額＋每分鐘限流鎖住；重生金鑰立即讓舊的失效。

**中轉直通**：DROP 名單剝掉連線層／CF／身分標頭；路徑重新編碼防注入；上游目標＝
管理員設定的 base_url，會員控制不了主機；計量只掃「回應」尾端，絕不緩衝會員請求本體；
會員斷線立即 cancel 上游（pump 不用 tee，不燒錢）；每請求一列 req_log 可追帳。

**VPN 訂閱**：token 放網址是為了 VPN App 相容性（App 不會帶 cookie）的必要取捨 —
可重生、有格式檢查、封鎖／未批准者即使 token 對也拿不到內容；上游網址永不出現在回應；
v1.0.0 起無 vpn 權限者連 `/vpn` 頁面存在都看不到（隱形）。

**管理員 API**：雙身分（Bearer 金鑰／管理員 cookie＋Origin）；金鑰明文只在 gitignored 的
ADMIN.local.md、v1.0.0 發佈時輪替（舊值在 git 歷史裡 — repo 公開前必須 filter-repo，記 DEBT）；
所有變更寫 audit_log 且絕不含秘密；root 管理員帳號網頁上不可封鎖／降級／刪除。

**SSE 串流**：上游錯誤對會員淨化（不洩提供商身分）、管理員看原文；會員中斷 → 上游取消；
輸出在瀏覽器端經 marked＋DOM 消毒（去 script／on*／js: 網址），聊天區是無 script 的內容 —
惡意上游注入的 HTML 拿不到 nonce，CSP 直接封殺。

**匿名體驗模式（v2.0.0，ADR-0009）**：未驗證的聊天端點直指付費上游＝燒錢面。渠道鎖
在查庫**之前**就擋（探測不到其他渠道 slug）、模型白名單、輸入 4k 字、每則回覆長度上限選填
（demo_max_tokens，2026-07-21 起預設不填＝不限）；
DO 雙保險 **fail-closed** 限流（每 IP 分鐘/日＋全站日），DO 壞→503 絕不放行 — 與會員路徑的
fail-open 刻意相反。對話與記帳都掛在永遠無法登入的 `demo:public` 合成帳號下，訪客**沒有任何
讀取管道**（列表／讀取／刪除都先過 pgUser：匿名 401、會員綁自己的 user_id），所以看不到自己
也看不到別人的試聊，只有管理員的 /logs 看得到。最壞日燒錢
＝全站日上限×每則回覆上限（後者預設不限，真正扛住的一直是全站日上限）；settings 一鍵關閉免部署。

**D1**：全部參數綁定（無字串拼 SQL）；寫入長度上限；觀測性寫入永不影響請求本體；
每日 cron 全庫 JSONL 備份進私有 R2（BLOB 排除、保留 14 份，src/cron.ts）；手動 export 當第二保險（ADMIN.md）。

**瀏覽器面（Stored-XSS，v2.0.0 修復）**：管理員寫的文章／頁面 Markdown 由伺服器用 marked
轉 HTML，而 marked **會原樣放行內嵌的原始 HTML** — 管理 token 失竊（或日後低權限作者角色）
就能在文章裡存 `<script>`／`onerror=`。內容與執行之間現在有兩道獨立防線：
① **白名單消毒器**（`src/lib/sanitize.ts`，零依賴、約 130 行）套在每個 `marked.parse()` 輸出上
（SSR 文章／頁面內文與 `?html=1` API）：標籤白名單、逐標籤屬性白名單（剝 `on*`／`style`）、
危險容器連內容整段丟、href/src scheme 白名單（先實體解碼＋去控制字元，擋 `javascript:`／
`data:text/html`／`&#106;avascript:`／`java\tscript:`）。
② **nonce 標記制**（不再全體蓋章）：`html()` 只對外殼自己標記的 `<script data-nonce>` 蓋 nonce，
不再蓋 body 裡所有 `<script>`；任何從內容層混進來的 script 都沒有 nonce → 被
`script-src 'self' 'nonce-…'` 封殺。就算消毒器哪天漏了，這一層仍撐得住。
靜態 SPA 用 sha256 hash（CI 防漂移）；`frame-ancestors 'none'`＋nosniff＋HSTS＋COOP；
全站零 inline 事件屬性；`style-src 'unsafe-inline'` 暫留（記 DEBT）；CSP 違規 10% 取樣進錯誤日誌。

## 明知且接受的風險
Cloudflare 預設之外無 WAF／bot 管理；VPN token 網址可能被偷看（可重生）；
中轉內容上游必然看得到（中轉的本質）；D1 單區域，可用性綁 Cloudflare。

## 明知且接受的風險（2026-07-22 展開版）

上面那段是短版。下面四條特別寫開，因為每一條都是讀者找得到的真實弱點，而
**「沒注意到」跟「想過之後決定不修」從外面看起來一模一樣**——除非決策被寫下來。
每條都寫清楚拿什麼換什麼，以及**什麼情況會改變這個決定**：沒有反轉條件的風險評估只是藉口。

**① `goodOrigin` 在正式站放行 localhost Origin**（`auth.ts:237`，`test/unit/auth.test.ts`
記錄了這是刻意的）。風險真實但很窄：攻擊者得讓**已登入的管理員**在自己的迴環介面上載入
他控制的頁面（本機開發伺服器、Electron App、自己起的 listener）。這個前提比一般 CSRF
難得多，但對開發者的機器不是不可能——而那正好就是持有管理員 cookie 的族群。
換到的是：能從 `wrangler dev` 直接打正式 API，不必再維護第二份 origin 白名單。
**反轉條件**：出現第二個管理員帳號，或管理員 cookie 落在開發者以外的人手上——
屆時這條例外應該比照 `adminOk` 改成閘在 `isDevEnv(env)`（見 ④）。

**② 每日 R2 備份含明文機密**（`cron.ts:91-108`）：`relay_channels`／`users`／`settings`／
`vpn_channels` 都用 `cols:"*"`，所以每份日備份含**上游明文 API key、TG bot token、
全體會員的 VPN token**，而且保留 14 份。**這不是 code bug**——金鑰本來就得明文存 D1 才能
轉發（ADR-0003），忠實的備份必然含它。值得記下來的是**爆炸半徑的位移**：`media.data`
為了 CPU 被細心排除，代表欄位清單是想過的——但只想了大小，沒想過敏感度。結果是
14 份滾動副本躺在**另一個存取控制面完全不同的儲存系統**裡，而威脅模型推理的並不是那一個。
**反轉條件**：維護者以外的人拿到 R2 讀權限。比較便宜的半套修法（備份時遮罩機密欄位）
有真實代價：備份會不再能直接還原成可用系統，而那正是備份存在的大半理由。（DEBT #20）

**③ `vpn_token` 明文存**（`0001_baseline.sql:103`）：同一張表的 `sessions.sid` 與
`api_key_hash` 都雜湊了，schema 註解還寫了理由；`vpn_token` 同樣是 bearer credential
卻是明文。查詢是精確比對，改雜湊不必動查詢、索引照用——便宜，只是一直沒做。
**配上 ②，一份 R2 備份 ＝ 全體會員的 VPN 訂閱**；是這個組合、而不是單獨任一條，
讓兩者都被寫進來。**反轉條件**：下一次動到 `users` 表的 migration（DEBT #21）。

**④ 更正 §2.4——路徑重新編碼不等於防 traversal**：§2.4 把「path 片段重新編碼
（`encodeURIComponent`）」寫成防篡改手段，**這個說法不精確**：`encodeURIComponent`
不轉義 `.`，所以 `.` 與 `..` 原封不動地通過（`relay/[[path]].ts:83-86`）。
目前打不到——host 來自管理員設定的 `base_url`、使用者控制不了，最糟也只是打到
「管理員已經授權的那個上游」的別條路徑。但只要有渠道的 `base_url` 帶了路徑前綴
（`https://host/api/v1`），`..` 就能爬出那個前綴。記在 DEBT #22；修法是直接拒收
等於 `.` 或 `..` 的片段。
