# uaip — edge-native LLM 中轉站＋個人門戶

[![CI](https://github.com/Jhongwe1/ipua/actions/workflows/ci.yml/badge.svg)](https://github.com/Jhongwe1/ipua/actions/workflows/ci.yml)
&nbsp;線上：**<https://uaip.cc.cd>** · English: **[README.md](./README.md)**

單人維護的工程案例：**零框架、執行期零依賴**的 LLM 中轉站＋會員系統＋計量配額＋
可觀測性＋完整內容門戶，全部跑在單一 Cloudflare Worker 加一顆 D1（SQLite）上。
沒有伺服器、沒有容器、執行期不用打包 — `git push` 就是整條供應鏈。

## 功能一覽

| 服務 | 路徑 | 說明 |
|---|---|---|
| **API 中轉站** | `/relay/{渠道}/…` | 會員一把 `uak-` 金鑰＋一個網址接上任何上游（OpenAI／Anthropic／Gemini／自架）。上游金鑰永遠不離開伺服器。串流直通、每人每日配額＋每分鐘限流、從**回應**串流掃 token／延遲計量。 |
| **LLM Playground** | `/playground` | 網頁聊天（同一批渠道）；對話存 D1；SSE 串流，上游錯誤對會員淨化（不洩提供商身分）。 |
| **VPN 訂閱** | `/vpn` | 多上游合併成一條會員網址。未被批准的人**完全看不到它的存在**（選單、頁面、API 欄位全隱形）。 |
| **內容門戶** | `/news` `/articles` `/p/{slug}` | SSR 新聞／文章系統（圖片存 D1、RSS、sitemap、OG/JSON-LD）；自訂頁面用 API 就能開。 |
| **工具** | `/` `/ip` `/ua` | 最早的 IP／UA 查詢 SPA。 |
| **管理** | `/members` `/admin` `/logs` `/api-docs` | 會員／服務／配額管理、文章後台、訪客＋錯誤＋用量儀表板、自架 API 文件。 |

身分：Google OAuth → HttpOnly session（sid 只存雜湊）。每個會員可**分服務批准**
（relay／vpn／playground）；管理員＝環境變數欽定的信箱清單。所有管理變更都寫稽核日誌。

## 設計裁決（ADR，誠實記錄取捨）

- [ADR-0001 零框架、執行期零依賴](./docs/adr/0001-zero-framework.md)
- [ADR-0002 一顆 D1 打天下](./docs/adr/0002-d1-only.md)
- [ADR-0003 共享上游金鑰＋配額，而非 BYOK](./docs/adr/0003-shared-key-quota-not-byok.md)
- [ADR-0004 CSP：SSR 用 per-request nonce＋靜態用 sha256](./docs/adr/0004-csp-nonce-plus-hash.md)
- [ADR-0005 中轉計量用 pump 而非 tee()](./docs/adr/0005-relay-pump-metering-not-tee.md)
- [ADR-0006 Pages → Workers 遷移](./docs/adr/0006-pages-to-workers.md)
- [ADR-0007 DO 限流器](./docs/adr/0007-durable-object-rate-limiter.md)
- [ADR-0008 全面 TypeScript（strict）](./docs/adr/0008-typescript-strict.md)

另見：[威脅模型（STRIDE）](./docs/THREAT-MODEL.md) ·
[與 one-api／LiteLLM／OpenRouter／AI Gateway 的誠實對照](./docs/COMPARISON.md) ·
[已知債務](./DEBT.md) · [延遲/成本報告骨架](./docs/REPORT-SKELETON.md) · [安全政策](./SECURITY.md)

## 工程證據（v1.0.0）

- **170+ 個測試跑在 workerd 裡**（`@cloudflare/vitest-pool-workers`）— 跟正式站同一顆
  runtime：真的 D1、真的 crypto、真的串流。直接 import handler（含 bracket 檔名）、
  手造 context 驅動；上游用 fetchMock 攔截，斷言「上游實際收到什麼」
  （標頭剝除、金鑰置換、串流位元組保真）。
- **CI**（GitHub Actions）：typecheck → 測試 → apidoc 防漂移 → CSP hash 防漂移。
  部署刻意留在本機（`npm run deploy`）。
- **計量**：中轉與 Playground 每個請求寫一列 `req_log`（狀態、耗時、首字延遲、
  token 進出 — 只掃回應尾端，絕不緩衝請求本體）。`/logs` 有訪客／錯誤／用量三分頁含 p50/p95。
- **Schema 即程式**：`migrations/` 是唯一來源；測試每次先套 migration；
  正式庫升級＝`npm run migrate:remote`（純增量）。

## 開發／測試／部署

```bash
npm ci                    # 開發工具鏈（vitest、wrangler、tsc）— 執行期依然零依賴
npm run migrate:local     # 從 migrations/ 建本機 D1
npm run seed              # 選用：本機種子（管理員＋會員＋示範渠道）
npm run dev               # http://localhost:8787（localhost 的管理員 API 免金鑰）
npm run checks            # typecheck＋全部測試
npm run deploy            # 重建 apidoc＋wrangler deploy
npm run migrate:remote    # 正式庫套新 migration（要在 deploy 之前跑）
```

首次設定（Cloudflare 登入、Google OAuth 憑證、管理員信箱）見 [ADMIN.md](./ADMIN.md)。
API 快速上手（發文、開頁面、掛選單）見 [API.md](./API.md)（線上版在 `/api-docs`）。

## 文件地圖

| 文件 | 內容 |
|---|---|
| [API.md](./API.md) | **完整 API 文件**：所有端點、參數、欄位規則、curl 範例（線上 /api-docs 的原稿） |
| [AGENTS.md](./AGENTS.md) | **給 AI agent 的操作指南**：金鑰在哪、照抄流程、驗證清單 |
| [ADMIN.md](./ADMIN.md) | 管理員維護筆記：部署眉角、資料庫維護、會員系統設定（金鑰明文只在 gitignored 的 ADMIN.local.md） |
| [DEBT.md](./DEBT.md) | 已知債務與門檻（何時該還） |
| `.claude/skills/uaip-api/` | Claude Code skill 入口（薄殼，指向 AGENTS.md 與 API.md） |

---

*個人專案，repo 同時作為自己的備份。*
