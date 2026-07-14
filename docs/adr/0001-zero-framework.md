# ADR-0001: Zero framework, zero runtime dependencies

**Status**: accepted · **Date**: 2026-07-14 (documenting a choice made 2026-07-06)

## Context

The site began as a static IP/UA tool and grew into a CMS, member system, LLM gateway and
playground. At every step there was a temptation to adopt a framework (Hono, Next-on-Pages,
Remix) or utility packages (jose for JWT, zod for validation, a UI kit).

## Decision

The **runtime has zero npm dependencies**. Pages Functions are plain ESM handlers; HTML is
template strings through one shared shell (`lib/site.js pageShell`); validation is hand-rolled
per endpoint; crypto is WebCrypto; the only vendored code is `marked` (checked into
`lib/vendor/`, no install). The dev toolchain (vitest/wrangler/tsc, added in v1.0.0) is
devDependencies only — nothing from npm executes in production.

## Consequences

**Won**: no supply-chain surface in production; cold starts stay minimal (no framework
bootstrapping); every byte of running code is in the repo and reviewable; upgrades never
break the site because there is nothing to upgrade; the whole app fits in one person's head.

**Paid**: no router (file-based routing + one catch-all does everything); repetitive
`adminOk` / `json` boilerplate per endpoint; hand-rolled validation must be tested
(v1.0.0's test suite exists partly to backfill this); HTML-in-strings is uncomfortable
beyond a few hundred lines (the playground page is the pain ceiling); no ecosystem
middleware (CSP, metering, audit were all built by hand — see ADR-0004/0005).

**Revisit when**: a second regular contributor joins, or any single page's inline JS
exceeds ~1,000 lines.

---

**中文摘要**：執行期零 npm 依賴 — Functions 是純 ESM、HTML 是樣板字串過單一外殼、
驗證手寫、marked 直接 vendor 進 repo。換到的是零供應鏈風險、極小冷啟動、全碼可審、
永不因升級而壞；代價是樣板重複、驗證要靠測試補、超過千行的頁面內嵌 JS 開始難受。
出現第二位常態貢獻者或單頁 JS 破千行時重新評估。
