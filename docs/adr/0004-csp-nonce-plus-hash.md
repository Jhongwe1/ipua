# ADR-0004: CSP — per-request nonce for SSR, sha256 hash for the static SPA

**Status**: accepted · **Date**: 2026-07-14

## Context

Every page carries inline `<script>` (the shared shell's i18n/theme/sidebar code and each
page's app code are inlined by design — see ADR-0001). A useful CSP must therefore either
allow `'unsafe-inline'` (pointless), enumerate hashes, or use nonces. The site has two
delivery paths: SSR pages all exit through one function (`lib/site.js html()`), and the
static SPA (`public/index.html`) is served by Pages' asset host where no code runs.

## Decision

- **SSR**: `html()` generates a fresh 128-bit nonce per response and stamps it on every
  `<script` tag with one regex, then emits
  `script-src 'self' 'nonce-…'` (+ HSTS, COOP, nosniff, frame-ancestors 'none',
  report-uri `/api/csp-report`). One entry point makes this safe: no page can forget it.
- **Static SPA**: `_headers` carries `script-src 'self' 'sha256-<hash of the single inline
  script>'`. `tools/check-csp.mjs` recomputes the hash in CI, failing on drift both ways
  (script changed / stale hash left behind). `.gitattributes` pins LF so Windows and CI
  hash identical bytes.
- `miniPage` (script-free auth pages) gets `script-src 'none'`.
- **Kept**: `style-src 'unsafe-inline'` — the shell and pages use large inline styles;
  converting them is real work with little payoff (recorded in DEBT.md). A site-wide audit
  found **zero** inline `on*=` handlers, so script never needs `'unsafe-inline'`.
- Violations POST to `/api/csp-report` (10% sampled → errlog), so a broken policy is
  visible in `/logs` instead of silently blanking pages.

## Consequences

**Won**: injected `<script>` (stored XSS in content, malicious upstream HTML in playground
markdown) won't execute; clickjacking and MIME sniffing closed; drift is caught pre-deploy.

**Paid**: the nonce regex blesses *every* script tag in SSR output — acceptable because all
SSR HTML is authored server-side by admin-trusted code paths; `style-src` remains open;
static CSP must be regenerated when the SPA's inline script changes (automated check, manual fix).

---

**中文摘要**：SSR 全部走 html() 單一出口 → 每回應一顆 nonce、regex 蓋章到所有 script；
靜態 SPA 用 sha256 寫進 _headers，CI 用 tools/check-csp.mjs 雙向防漂移（.gitattributes
釘 LF 讓 Windows 與 CI 算同一個 hash）；miniPage 直接 script-src 'none'。
style 暫留 unsafe-inline（記 DEBT）；全站零 inline 事件屬性所以 script 不需退讓。
CSP 違規 10% 取樣進 errlog，政策壞了看得到。
