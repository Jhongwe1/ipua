# ADR-0010: OpenAPI 3.1 as a build artifact; docs become a public three-piece set

**Status**: accepted · **Date**: 2026-07-17 (v2.0.0 Phase L)

## Context

The API was documented in one place: `API.md`, a hand-written Chinese narrative
that doubles as the `/api-docs` page (compiled to a string module by
`tools/build-apidoc.mjs`). That's great for humans and useless for machines —
no typed contract, nothing a client generator or a linter can consume. Going
public (Phase O) also flips a v1 decision: `/api-docs` sat behind the admin key
gate, which makes no sense for a portfolio repo whose whole point is showing the
API surface.

## Decision

1. **`docs/openapi.yaml` is hand-written** and covers **every route in
   `src/routes.ts`** — including HTML pages (tagged `頁面`) so the spec is a
   complete route inventory, not just the JSON API.
2. **Compiled, not parsed at runtime**: `tools/build-openapi.mjs` (using the
   `yaml` package as a devDependency) emits `src/lib/openapi.ts`, served by
   `GET /openapi.json`. The worker keeps its zero-runtime-dependency rule
   (ADR-0001) — same pattern as `apidoc`.
3. **Drift is a CI failure, in both directions**: `test/int/openapi.test.ts`
   checks route table ⊆ spec paths and spec paths ⊆ route table (with
   `:id`→`{id}`, `*path`→`{path}` mapping), that every registered method is
   documented, and that every `` `METHOD /path` `` in API.md's overview tables
   exists in the spec. CI also re-runs both build scripts and fails on diff.
4. **`/api-docs` goes public** (noindex kept): the page now server-renders
   API.md through the same marked + whitelist-sanitizer pipeline as articles,
   plus an "interactive reference" tab backed by **vendored Scalar**
   (`public/assets/vendor/scalar.js`, ~3.6 MB) — lazy-loaded on first click so
   readers of the narrative docs never pay for it. Vendoring keeps CSP at
   `script-src 'self'` + nonce (no CDN origin), same reasoning as vendored
   marked.
5. **The sync duty is now a three-piece set**: any API change = `API.md` +
   `docs/openapi.yaml` + regenerate (`npm run apidoc` / `npm run openapi`).
   AGENTS.md and the uaip-api skill spell this out.

## Consequences

- Adding a route without documenting it is impossible (test fails), which is
  the entire point.
- The YAML is maintained by hand — richer schemas (full response typing) are
  future work; summaries and shapes are enough for the portfolio goal.
- 3.6 MB of vendored Scalar sits in the repo; acceptable, it's lazy-loaded and
  the alternative (CDN) would punch a hole in CSP.

---

**中文摘要**：API 文件從「API.md 單件」升級成公開三件套 — **API.md（人讀敘事，中文）＋
docs/openapi.yaml（手寫機器契約，蓋全部路由含 HTML 頁）＋自動產生的 apidoc/openapi 模組**。
規格是建置產物不是執行期解析（yaml 只進 devDependencies，worker 維持零執行期依賴），
由 `GET /openapi.json` 供應。防漂移雙向核對進 CI：路由表×規格 paths 一一對應、方法對齊、
API.md 總覽的每個端點都要在規格裡 — 加路由不補文件直接紅燈。`/api-docs` 拆掉金鑰閘門改公開
（noindex 保留）：伺服器端渲染 API.md（同文章消毒管線）＋vendored Scalar 互動式參考
（3.6MB 懶載入；vendor 而非 CDN 是為了 CSP 'self' 不開洞，跟 marked 同理）。
