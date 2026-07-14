# ADR-0003: Shared upstream keys + quotas, not BYOK

**Status**: accepted · **Date**: 2026-07-14

## Context

The relay forwards member requests to paid upstreams using keys the admin configures per
channel. Two models exist in the wild: **BYOK** (each member brings their own upstream key;
the relay is a pure proxy, e.g. LiteLLM in passthrough mode) and **shared keys** (the
operator's keys serve everyone; one-api/new-api style). Shared keys mean the operator pays
for every member request — uncontrolled, that's an unbounded liability.

## Decision

Keep **shared keys** (that is the product: members get access they couldn't provision
themselves), and make the liability bounded with **metering + quotas** instead of switching
to BYOK:

- every request logged (`req_log`: user, channel, model, status, latency, tokens),
- per-user daily quotas + rolling per-minute rate limit, personal overrides > global
  settings > built-in defaults (500 relay/day, 200 pg/day, 30/min),
- admin fully exempt (the operator's own agents must never get 429s from their own site),
- quota checks fail-open (metering outage must not take the service down).

BYOK is deferred to v2 (recorded in DEBT.md).

## Consequences

**Won**: the member experience stays "one key, zero setup"; cost exposure is capped and
observable per member/channel/model; abuse is answerable (audit + revoke + quota to 0).

**Paid**: the operator still fronts all costs; quotas are request-count based, not
dollar-based (token counts are recorded but not priced — pricing tables per provider are
a maintenance burden, deferred); a leaked member key can burn exactly one day's quota
before its owner regenerates it.

**Revisit when**: a member legitimately needs more volume than the operator wants to fund
(add BYOK per-channel), or monthly upstream spend exceeds what a hobby budget tolerates.

---

**中文摘要**：維持共享金鑰（這才是產品價值：會員拿到自己弄不到的存取），
用計量＋配額把風險變有界，而不是改 BYOK。每請求一列 req_log、每人每日配額＋
每分鐘限流、個人覆寫→全域→內建預設、站長全豁免、配額系統故障時放行。
代價：成本仍由站長墊、配額算次數不算錢（token 有記但沒計價）。BYOK 留 v2。
