# Threat Model / 威脅模型

> STRIDE analysis of every trust boundary in uaip.cc.cd (v2.0.0, 2026-07).
> English first; 繁體中文在後半。Scope: the Cloudflare Pages app (Functions + D1 + static SPA).
> Out of scope: Cloudflare platform itself, Google OAuth infrastructure, upstream LLM/VPN providers' internals.

## 1. System sketch

```
Browser ──(HTTPS)── Cloudflare Pages
  ├─ static SPA (/, /ip, /ua)            ← _headers CSP (sha256)
  ├─ SSR pages via lib/site.js html()    ← per-request nonce CSP
  └─ Functions
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

### 2.8 D1 (single database)
- All queries use bound parameters (no string-built SQL with user input; LIMIT/OFFSET are parseInt-validated).
- Media BLOBs capped at 1.8 MB; text columns length-clamped at write time.
- Observability writes (req_log/errlog/audit_log) are fire-and-forget and never fail the request.
- Backups: manual `wrangler d1 export` (see ADMIN.md); no automated backup (accepted risk for a personal site, DEBT).

### 2.9 Browser surface (XSS / clickjacking / MIME)
- **Stored-XSS via markdown (fixed v2.0.0):** admin-authored article/page markdown is rendered server-side with `marked`, which passes **raw embedded HTML through verbatim**. A stolen admin token (or a future lower-privilege author role) could store `<script>`/`onerror=` in a post. Two independent defenses now stand between content and execution:
  1. **Whitelist sanitizer** (`lib/sanitize.js`, zero-dep, ~130 lines) runs on every `marked.parse()` output — SSR article/page bodies and the `?html=1` APIs. Tag whitelist, per-tag attribute whitelist (drops `on*`/`style`), dangerous containers (`script`/`style`/`iframe`/`svg`/…) dropped with their contents, and href/src scheme whitelist with entity-decoding + control-char stripping (blocks `javascript:`, `data:text/html`, `&#106;avascript:`, `java\tscript:`).
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

---

# 繁體中文版

> 對 uaip.cc.cd（v1.0.0）每一條信任邊界做 STRIDE 分析。
> 範圍：Cloudflare Pages 應用本體（Functions＋D1＋靜態 SPA）；
> 不含 Cloudflare 平台、Google OAuth 基礎設施、上游 LLM／機場的內部。

## 入口 × 威脅重點

**Google OAuth**：`state` 亂數綁 HttpOnly cookie（10 分鐘）防 CSRF 登入；token 由伺服器直連
Google 交換（TLS、來源可信）；`aud` 必須是自己的 client id；`email_verified` 必須為真；
站長身分只認 `ADMIN_EMAILS` 環境變數，網頁上動不了。登入失敗進站內錯誤日誌。

**Session cookie**：HttpOnly＋Secure＋SameSite=Lax；**資料庫只存 sid 的 SHA-256** —
資料庫外洩拿不到能用的 cookie。過期即失效；站長可 `revoke_sessions` 踢人、
會員可 `/api/account/logout-all` 自救。所有 cookie 身分的寫入端點都驗 `Origin`。

**會員金鑰（uak-）**：產生當下顯示一次，庫內只有雜湊＋提示；先過格式檢查再查庫；
四個擺放位置在轉發前全部剝除、`?key=` 從查詢字串刪掉。外洩影響面＝relay 一項，
且被日配額＋每分鐘限流鎖住；重生金鑰立即讓舊的失效。

**中轉直通**：DROP 名單剝掉連線層／CF／身分標頭；路徑重新編碼防注入；上游目標＝
站長設定的 base_url，會員控制不了主機；計量只掃「回應」尾端，絕不緩衝會員請求本體；
會員斷線立即 cancel 上游（pump 不用 tee，不燒錢）；每請求一列 req_log 可追帳。

**VPN 訂閱**：token 放網址是為了 VPN App 相容性（App 不會帶 cookie）的必要取捨 —
可重生、有格式檢查、封鎖／未批准者即使 token 對也拿不到內容；上游網址永不出現在回應；
v1.0.0 起無 vpn 權限者連 `/vpn` 頁面存在都看不到（隱形）。

**站長 API**：雙身分（Bearer 金鑰／站長 cookie＋Origin）；金鑰明文只在 gitignored 的
ADMIN.local.md、v1.0.0 發佈時輪替（舊值在 git 歷史裡 — repo 公開前必須 filter-repo，記 DEBT）；
所有變更寫 audit_log 且絕不含秘密；root 站長帳號網頁上不可封鎖／降級／刪除。

**SSE 串流**：上游錯誤對會員淨化（不洩提供商身分）、站長看原文；會員中斷 → 上游取消；
輸出在瀏覽器端經 marked＋DOM 消毒（去 script／on*／js: 網址），聊天區是無 script 的內容 —
惡意上游注入的 HTML 拿不到 nonce，CSP 直接封殺。

**D1**：全部參數綁定（無字串拼 SQL）；寫入長度上限；觀測性寫入永不影響請求本體；
備份靠手動 export（個人站接受的風險，記 DEBT）。

**瀏覽器面（Stored-XSS，v2.0.0 修復）**：站長寫的文章／頁面 Markdown 由伺服器用 marked
轉 HTML，而 marked **會原樣放行內嵌的原始 HTML** — 管理 token 失竊（或日後低權限作者角色）
就能在文章裡存 `<script>`／`onerror=`。內容與執行之間現在有兩道獨立防線：
① **白名單消毒器**（`lib/sanitize.js`，零依賴、約 130 行）套在每個 `marked.parse()` 輸出上
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
