# ADR-0009: Public demo mode is fail-closed (the inverse of member quotas)

**Status**: accepted · **Date**: 2026-07-17 (v2.0.0 Phase K)

## Context

The playground previously required a Google sign-in plus per-member approval. For a
public portfolio repo we want a "try it without signing in" path — but anonymous
traffic pointed at a paid LLM upstream is a money-burning surface: no identity, no
recourse, and bots find open endpoints fast. Member quotas (ADR-0007) are
deliberately **fail-open** — if the quota system breaks, members are served,
because availability for known, approved people beats accounting. That trade is
wrong for strangers.

## Decision

Anonymous `POST /api/playground/chat` is served only when the admin has switched
demo mode on (`settings demo_mode='1'` **and** `demo_channel` set), and the demo
path is locked down on every axis:

- **Channel and model allowlist** (`demo_channel`, `demo_models`; empty list =
  all models of that one channel). The channel lock is checked **before** the DB
  lookup, so anonymous callers cannot probe other channel slugs.
- **Small inputs, short outputs**: 4k input chars total; `max_tokens` forced to
  `demo_max_tokens` (default 512) for all three upstream kinds.
- **Nothing persists**: no `pg_conversations` / `pg_messages` rows — the chat
  lives only in the visitor's browser. Only `req_log` is written, attributed to a
  lazily-created synthetic user row `google_sub='demo:public'` (which can never
  log in), so cost accounting (Phase J) covers demo traffic for free.
- **Fail-closed double rate limit** reusing the Phase H `RateLimiter` DO:
  one instance per IP (`demo-ip:<ip>`, per-minute default 3 + per-day default 10)
  plus one global instance (`demo:global`, per-day default 200). If the DO is
  unbound or throws → **503, never allow** (and an `errlog` row `demo.do`, which
  the Telegram alert cron picks up).

Worst-case daily burn is bounded by `demo_global_day × demo_max_tokens` output
tokens (~200 × 512 at defaults) regardless of attacker behavior, and the admin
can kill the whole surface with one settings write (`demo_mode: false`), no
deploy.

## The deliberate asymmetry

| | member quota (ADR-0007) | demo limits (this ADR) |
|---|---|---|
| identity | approved account | none (IP only) |
| on limiter failure | **fail-open** (serve) | **fail-closed** (503) |
| who bears the failure | admin absorbs risk for known users | anonymous visitors just retry later |

Same DO class, opposite failure policy — the policy lives in the caller
(`lib/quota.ts` vs `lib/demo.ts`), which is why the DO itself stays policy-free.

## Consequences

- A DO outage silently disables the public demo (503) while members keep
  working — exactly the intended priority.
- Per-IP limits are honest-visitor limits, not bot-proof (IPs rotate); the
  global cap is the actual financial backstop.
- The demo user row shows up in member lists as a pending, service-less account;
  admins should leave it alone (deleting it just gets it re-created).

---

**中文摘要**：體驗模式讓「完全沒登入」的訪客直接試聊，但匿名流量打付費上游＝燒錢面，
所以限流哲學跟會員配額**刻意相反**：會員 fail-open（配額系統壞了照樣服務熟人）、
demo **fail-closed**（DO 壞了直接 503，絕不放行陌生人）。鎖渠道＋模型白名單（先擋再查庫，
探測不到其他渠道）、輸入 4k 字、強制 `demo_max_tokens`（預設 512）；對話**不落地**，
只寫 req_log、記在懶建的 `demo:public` 合成帳號上（成本記帳自然涵蓋）。雙保險＝每 IP
一顆 DO（分鐘 3／日 10）＋全站一顆（日 200）；最壞燒錢上限＝全站日上限 × max_tokens，
管理員一鍵 `demo_mode:false` 免部署關閉。同一顆 DO、相反的失效策略 — 策略住在呼叫端，
DO 本身保持無策略。
