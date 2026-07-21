# Production report — real numbers from a small, real deployment

> Written 2026-07-17 for the v2.0.0 release, following the method fixed in
> [REPORT-SKELETON.md](./REPORT-SKELETON.md). Data source: production D1
> (`req_log` / `visits`; queries listed at the bottom for reproducibility).
> **This is a personal site with a handful of users — the numbers are small and
> reported honestly.** The point is the *measurement machinery*, not the scale.

## Window

Site live since **2026-07-06** (11 days at time of writing). LLM metering
(`req_log`) live since **2026-07-14** (3 days of request data). 90-day rolling
retention; `usage_daily` (migration 0003) preserves aggregates beyond that.

## Traffic

| metric | value |
|---|---|
| page views (11 days) | 1,355 |
| unique IPs | 161 |
| busiest day | 2026-07-15 (201 views) |
| quietest day | 2026-07-10 (46 views) |

## LLM requests (playground, 2026-07-14 → 2026-07-16)

| metric | value |
|---|---|
| requests | 10 (all `svc=pg`; relay had no member traffic in this window) |
| error rate | **0 / 10** (0%) |
| model | `gemini-3.1-flash-lite` (single channel configured) |
| tokens | 1,525 in / 2,405 out (upstream-reported) |

### Latency (n=10 — treat as anecdote, not distribution)

| percentile | TTFB (ms) | total duration (ms) |
|---|---|---|
| p50 | 502 | 761 |
| p95 | 704 | 3,725 |

Reading it the way the skeleton prescribes: **TTFB is tight** (419–704 ms —
upstream responsiveness plus one edge hop), while **total duration spreads with
output length** (the 3.2 s / 3.7 s outliers are simply longer generations, not
slowness). This is exactly the pattern the pump architecture predicts: the
worker adds no buffering, so total time ≈ upstream generation time.

### Cost shape (estimated)

At the provider's public list price for this model class (illustrative
$0.10 / $0.40 per M tokens in/out — set your own in `model_prices`):

> 1,525 × $0.10/M + 2,405 × $0.40/M ≈ **$0.0011 for the window** — effectively
> zero. The machinery matters at scale: `/logs` now shows per-channel and
> per-member estimated cost live, and `unpriced_models` nags about anything
> missing a price row.

## Reliability observations

- `errlog` total since launch: **5 rows** (OAuth experiments and one CSP
  violation sample during development — none from the relay/playground path).
- The v2 quota path (Durable Object) has served every counted request since
  2026-07-17 with zero `quota.do` degradation entries — the D1 fallback has
  never fired in production.
- Daily cron (rollup + backup + purge) and 5-minute alert scan report into
  `settings.cron_last_*`; first live runs verified 2026-07-17.

## Synthetic load test — local, **not** production traffic (added 2026-07-22)

Everything above is production data. This section is not: it is `wrangler dev` on a
desktop, driven by [`tools/loadtest.mjs`](../tools/loadtest.mjs) against
[`tools/mock-upstream.mjs`](../tools/mock-upstream.mjs). It is labelled separately
because mixing synthetic numbers into a production report is how reports start lying.

**Why it exists:** the rate limiter's only prior evidence was
`test/unit/rate-limiter.test.ts` — 30 in-process calls through `Promise.all`. That test
proves the *method body* never interleaves (no `await` inside `check()`), which is the
crux of ADR-0007. It does **not** prove the property survives 200 separate HTTP
connections, each carrying a router dispatch, a key lookup, a D1 read and a DO RPC
round-trip. Those are exactly the layers where a concurrency claim usually dies.

### Rate limiter under real HTTP concurrency

200 requests fired without waiting for any response, one member, `rl_per_min = 30`:

| outcome | count |
|---|---|
| `200` (allowed) | **30** |
| `429` (limited) | **170** |

Exactly the limit, never one more — the DO's single-threaded `check()` holds under real
concurrency, and blocked requests do not consume quota (`check()` increments only on the
allow path). Re-run with `node tools/loadtest.mjs`.

### Gateway overhead (n=400, upstream delay subtracted)

The mock upstream sleeps a fixed 25 ms, so `total − 25 ms` isolates what this worker
costs: auth, quota DO, channel lookup, header rewrite, and the metering pump.

| p50 | p95 | p99 | min | max |
|---|---|---|---|---|
| 36.5 ms | 49.7 ms | 56.1 ms | 22.3 ms | 69.4 ms |

**Read these as an upper bound on a bad day, not as production latency.** `wrangler dev`
runs a local workerd with none of the edge's warm-isolate advantages, D1 is a local SQLite
file rather than the managed service, and client, gateway and upstream share one machine's
CPU. The production TTFB table above (p50 502 ms including a real upstream) is the number
that describes reality. What this table is good for is *relative* comparison — re-run it
after changing the request path and see which direction it moves.

### Parse-side CPU (`tools/bench-sse.mjs`)

Reproduces ADR-0011 on demand: 5,982 synthetic deltas at 184 bytes each, full `JSON.parse`
versus `fastDelta`, with a correctness check that both paths emit byte-identical text
before any timing is reported. On the author's desktop the fast path is ~1.5× faster and —
the more interesting column — triggers **zero GC events** where the full parse triggers
several. That is ADR-0011's "allocation is billed twice" claim made visible: the fast path
allocates one string instead of an object tree, so there is nothing to collect.

## Caveats (as promised by the skeleton)

n=10 supports no statistical claim — the percentile table demonstrates the
reporting pipeline works end-to-end (raw `dur_ms` → client-side percentiles →
this document), not a latency benchmark. Token counts are upstream-reported.
Cost is an estimate (tokens × admin-maintained prices), not a bill. Single
region D1; the operator and most visitors are in Taiwan (`colo` mostly TPE).

## Reproduce

```sql
-- traffic
SELECT COUNT(*), COUNT(DISTINCT ip), MIN(ts) FROM visits;
SELECT substr(ts,1,10) d, COUNT(*) FROM visits GROUP BY d ORDER BY d;
-- llm requests
SELECT svc, COUNT(*), SUM(CASE WHEN status>=400 OR status=0 THEN 1 ELSE 0 END),
       SUM(tokens_in), SUM(tokens_out) FROM req_log GROUP BY svc;
SELECT dur_ms, ttfb_ms FROM req_log WHERE dur_ms IS NOT NULL ORDER BY dur_ms;
```
or `GET /api/admin/stats?days=30` (admin) — the same numbers the `/logs` usage
tab renders.

---

**中文摘要**：這是 v2.0.0 發佈時（2026-07-17）用正式站真實數據寫的報告 — 個人站、
用戶數一隻手數得完，**數字小但誠實**；重點是量測管線而非規模。上線 11 天 1,355 次瀏覽、
161 個不重複 IP。LLM 計量 3 天窗口：10 次請求、0 錯誤、tokens 1,525/2,405；
TTFB p50 502ms／p95 704ms 很緊，總耗時 p95 3.7s 是輸出長度拉的 — 正是 pump 架構
預測的形狀（worker 不緩衝，總時長≈上游生成時長）。估算成本 ≈ $0.0011（示意單價）。
n=10 不構成統計主張 — 展示的是「原始值→百分位→報告」這條管線全通。
2026-07-22 新增一節**本機合成壓測**（與正式數據分開標示，不混在一起講）：200 條真 HTTP
併發打限流器，恰好 30 個過、170 個 429 — ADR-0007 的原子性在真併發下成立，被擋的不吃額度。
gateway overhead 扣掉上游延遲後 p50 36.5ms／p99 56.1ms，但那是 wrangler dev 的本機
workerd，要當成「壞天氣的上限」而不是正式站延遲（正式站 TTFB p50 502ms 那張表才是現實）。
