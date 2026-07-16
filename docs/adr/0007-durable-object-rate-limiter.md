# ADR-0007: Durable Object rate limiter (atomic check-and-count, fail-open)

**Status**: accepted · **Date**: 2026-07-17 (v2.0.0 Phase H)

## Context

v1 quota enforcement was "COUNT rows in `req_log`, allow if under the limit". Two
concurrent requests read the same count and both get admitted — a classic
check-then-act race, explicitly noted as an accepted approximation in ADR-0002.
The Workers migration (ADR-0006) was done partly to unlock the fix: a Durable
Object is a single-threaded, globally unique instance, so "check and increment"
inside it is atomic by construction. **This atomicity — never overselling a
limit — is the reason the DO exists**, not performance.

## Decision

`src/do/rate-limiter.ts` — a SQLite-backed DO class (`new_sqlite_classes`, the
only kind on the free tier), **sharded one instance per member**
(`idFromName("u:" + user.id)`), with a single RPC method
`check({svc, perMin, perDay, now?})`:

- **Per-minute limit = two-bucket weighted sliding window**: only two counters
  (`m:<epoch-minute>` for the current and previous minute; shared across
  services, matching v1's 60-second window). Estimate = previous bucket ×
  remaining-overlap fraction + current bucket. O(1) storage, no per-request
  timestamps.
- **Daily quota = date-keyed lazy reset**: counter key is `d:<UTC-date>:<svc>`;
  the next day reads a different key, so old counters simply stop mattering (and
  are purged opportunistically on allowed calls). No alarms.
- `check()` is fully synchronous (`storage.sql.exec`, no awaits), so concurrent
  RPCs serialize and **exactly** `limit` calls pass — pinned by a `Promise.all`
  test. Denied requests don't consume quota. `now` is an injectable clock for
  tests only.

**Division of labor**: the caller (`lib/quota.ts checkQuota`) resolves the
limits (per-user override > global settings > built-in defaults) and builds the
429 responses; the DO only counts and compares. The external contract of
`checkQuota` is unchanged — relay and playground handlers didn't change at all.

**Three-tier degradation (fail-open)**: ① DO atomic path (disabled instantly by
setting `quota_do='0'` — no deploy needed); ② on DO failure or missing binding,
fall back to the v1 D1 COUNT path (approximate but serviceable; the failure is
recorded in `errlog` as `quota.do`); ③ if D1 is down too, **allow** — quota
must never take down the paid service it protects. (The upcoming demo mode is
deliberately the opposite, fail-closed; that asymmetry will be ADR-0009.)

## Consequences

**Won**: limits are now exact under concurrency; enforcement no longer does two
D1 COUNTs per request (one settings read + one DO RPC); the sliding window is
smoother than a fixed 60s look-back; per-member sharding means one hot user
can't contend with others.

**Paid**: enforcement counters and displayed usage now come from different
stores — `/api/me` and `/logs` still count `req_log`, the DO counts admissions
(including requests that later fail), so the numbers can drift slightly; one
more binding and class to understand; the D1 fallback path must be kept working
(it has its own pinned tests).

**Revisit when**: per-IP/demo limiting lands (Phase K reuses this class), or
usage display should read the DO instead of `req_log`.

---

**中文摘要**：v1 的配額是「COUNT req_log → 沒超就放行」，兩個並發請求會讀到同一個
計數、雙雙放行（ADR-0002 記過的競態）。換 DO 的核心理由就是原子性：同一 id 全球單
實例＋單執行緒，「檢查＋加一」天生原子、永不超賣。設計：每會員一顆（`u:<id>`）、
SQLite-backed；分鐘限流＝兩桶加權滑動窗（只存兩個計數、跨服務共用）；日配額＝
`d:<UTC日>:<svc>` 日期入鍵懶重置（隔天鍵名不同＝自動歸零，不用 alarm）；`check()`
全程同步 → 併發下恰好 limit 個過（有 Promise.all 測試釘住）。分工：limit 由
`checkQuota` 算好傳入（個人覆寫＞全域＞預設）、429 也由它組，DO 只管數 —
對外契約不變，relay/playground handler 零改動。三層降級（fail-open）：DO（settings
`quota_do='0'` 可一鍵停用）→ 退 v1 的 D1 COUNT（降級寫 errlog `quota.do`）→ 連 D1
都壞就放行 — 配額永不弄掛正職服務（demo 模式刻意相反、fail-closed，見 ADR-0009）。
代價：執法計數（DO）與顯示用量（req_log）分家、數字可能小幅漂移。
