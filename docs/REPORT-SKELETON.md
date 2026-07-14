# Latency / Cost Report — methodology skeleton

> A frame for writing up the relay's real-world behavior from production data. Not the report
> itself — the report needs weeks of live traffic. This fixes the method so numbers are
> comparable across runs. Data source: the `req_log` table (see migration 0002).

## Data source

`req_log(ts, user_id, svc, channel, model, status, dur_ms, ttfb_ms, tokens_in, tokens_out)`.
One row per relay/playground request. 90-day rolling retention (opportunistic purge). Pull via
`GET /api/admin/stats?days=N` (aggregates + up to 2000 raw dur values for percentiles) or SQL
in the D1 console.

## Questions the report should answer

1. **Latency by provider/model** — TTFB and total duration, p50/p90/p95/p99. TTFB is the
   honest "responsiveness" number; total duration is dominated by output length so always
   report it alongside `tokens_out`.
2. **Reliability** — error rate (`status>=400 or status=0`) per channel; is it the upstream
   or the relay? (relay-side failures show `status=0` + an `errlog` row with `src=relay.upstream`).
3. **Cost shape** — tokens in/out per model per day. Multiply by each provider's public price
   to estimate spend (uaip records tokens but doesn't price them — DEBT #10). This is where
   quota tuning decisions come from.
4. **Usage distribution** — requests per member; is one member's quota the binding constraint,
   or is the global default fine? Does anyone hit 429 regularly?
5. **Edge effect** — does D1 single-region write latency show up in `dur_ms` for far-away
   members? (logging is `waitUntil`, so it shouldn't — this validates that.)

## Method

- **Window**: report a fixed range (e.g. 14 or 30 days); state it. Exclude the first day of
  any new channel (warm-up / misconfiguration noise).
- **Percentiles**: computed client-side from raw `dur_ms` (the stats endpoint returns up to
  2000 recent raw values; `/logs` usage tab already does p50/p95). Don't average latencies —
  report percentiles.
- **Segment before aggregating**: always split by `model` first. Mixing a fast small model
  with a slow large one produces meaningless blended numbers.
- **Separate TTFB from total**: streaming makes total duration a function of output length;
  TTFB isolates upstream responsiveness.
- **Error accounting**: report error rate with the denominator (N requests), not just a count.
- **Reproducibility**: note the exact `?days=` / SQL used so a later run is comparable.

## Suggested tables

- Per model: N, error %, TTFB p50/p95, total p50/p95, mean tokens_out.
- Per day: N, error %, tokens_in/out totals (trend line).
- Per member: N, 429 count, top model — to decide quota defaults vs per-user overrides.

## Caveats to state in the report

Token counts are upstream-reported and null when a provider omits usage (custom channels
without `include_usage` — DEBT #7). Request-count quotas ≠ dollar cost. 90-day retention
bounds any longitudinal claim. Single-region D1 means latency numbers are relative to the
operator's/visitors' geography.

---

**中文摘要**：這是「怎麼寫延遲/成本報告」的方法骨架，不是報告本身（報告要幾週真實流量）。
數據源＝req_log（`GET /api/admin/stats?days=N` 或 D1 console）。要回答：各模型延遲
（TTFB 與總時長的 p50/p95）、可靠度（錯誤率、是上游還是中轉）、成本形狀（token×公開價）、
用量分布（誰會撞 429）、邊緣效應。方法：固定窗口、算百分位不算平均、先按 model 分段、
TTFB 與總時長分開、錯誤率要帶分母、記下查詢以利重現。注意：token 是上游回報可能為 null、
配額算次數不等於錢、90 天保留限制縱向結論。
