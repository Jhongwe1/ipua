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
