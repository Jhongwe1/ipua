# ADR-0011: Staying on the Workers free plan — the 10 ms CPU budget for streaming

**Status**: accepted · **Date**: 2026-07-21

## Context

Workers **free plan allows 10 ms of CPU per invocation**. Staying on it is a product
constraint, not an accident: the site is a personal portal and the owner declined the
$5/month Paid upgrade (which would raise the limit to 30 s and make this whole ADR moot).

The playground streams LLM replies through `POST /api/playground/chat`. Members reported
replies that **stopped halfway with no error**: no `{error}` event, no `{done}`, nothing in
`req_log`, nothing in the error log. When the budget is exceeded Cloudflare **kills the
isolate** — it does not raise a catchable error, so every persistence and logging path dies
with it. From inside the application the failure is invisible.

Two facts made this hard to diagnose and are worth stating plainly:

- **CPU time is not wall time.** `await fetch(...)` waiting 75 s on an upstream costs
  ~0 ms of CPU. `req_log.dur_ms` (avg 11 452 ms, max 75 107 ms) says nothing about the
  budget. Only code actually executing is billed.
- **Only `wrangler tail` shows it.** `Exceeded CPU Limit` appears in the live tail and
  nowhere else — not in `req_log`, not in `errlog`, not in the dashboard's error counters.

The measured workload (7 days, `req_log WHERE svc='pg'`): 86 requests, **avg 978 output
tokens, max 5 982**. Upstream emits roughly one SSE event per token.

## Decision

**Nothing in the per-delta loop may cost more than a few microseconds.** Any work whose
cost is proportional to reply length will eventually exhaust the budget, so the fix is
never "make it faster" — it is "stop doing it per delta".

Two independent linear costs existed, and both had to go:

### 1. Write side — batch deltas before forwarding (`c3c4e4a`)

Originally every upstream delta was `JSON.stringify`-ed, encoded and written to the
TransformStream individually (measured: 691 writes for one GLM-4.7 answer). Now `push()`
accumulates and `flush()` emits on a **100 ms / 1 000 character** threshold, cutting writes
by an order of magnitude while still reading as smooth character-by-character output.
Reasoning (`{r}`) and content (`{d}`) accumulate separately so their order is never mixed.

*Note*: `Date.now()` only advances after I/O in Workers, but every `reader.read()` is I/O,
so the time threshold does fire; the character threshold is the backstop.

### 2. Parse side — fast path that skips the object tree (`bc5c627`, `src/lib/fastsse.ts`)

`JSON.parse` on each delta was **7.02 ms of the 9.01 ms** loop cost at 5 982 deltas. The
cost is not scanning the bytes — it is materializing the tree. Each 184-byte chunk yields
**4 objects/arrays + 13 strings**, of which we want one string: ~101 694 short-lived
objects per long reply, all immediately garbage. **GC pauses count toward the CPU budget**,
so the allocation churn is billed twice.

`fastDelta()` locates the value with an unrolled-loop regex
(`/"(reasoning_content|reasoning|content)":"([^"\\]*(?:\\.[^"\\]*)*)"/g`) and calls
`JSON.parse('"' + raw + '"')` on **that fragment only** — V8 allocates one string, no tree.
Unescaping stays with the native parser, so `\n`, `\"`, `\uXXXX` and emoji surrogate pairs
are handled by V8 rather than a hand-rolled decoder.

It is a **bail-out-on-doubt** path, returning `null` (→ full parse) for: `"error"`,
`"usage":{`, `content:null` tail chunks, truncated JSON, or any unexpected shape.
The guard matches `"usage":{` and **not** `usage` — some upstreams attach `"usage":null` to
every chunk, and a loose match would downgrade every delta and negate the optimization.
`anthropic` / `gemini` chunk shapes differ and keep the full parse (traffic split: openai
69 requests, gemini 17; Gemini also emits far fewer, larger chunks).

Injection is not a concern: quotes inside a JSON string value are always encoded as `\"`,
so an unescaped `"content":"` cannot occur inside model output (covered by test).

Result at 5 982 deltas: **9.01 ms → ~4.2 ms** (local desktop; a Workers isolate is slower,
so treat these as lower bounds — the ratio is what matters).

## Rejected alternatives

- **Pure pipe** (`return new Response(upstream.body, upstream)`). Zero CPU and genuinely
  the right answer for a plain proxy, but this Worker is not one: it must hide upstream
  identity (raw SSE leaks `chatcmpl-` ids, real model names, provider error text — see
  ADR-0003's shared-key premise), persist the assistant reply to D1, and normalize three
  provider formats into one SSE contract. A pure pipe would empty the conversation history
  it was meant to serve.
- **Offloading work to the browser.** Already true — Markdown is rendered client-side
  (`marked.js` from `/assets/`); the Worker performs no Markdown or HTML work on this path.
- **Hand-written string scanner** instead of the regex. ~1.3 ms faster, but scanning for an
  unescaped closing quote without a bounds check hangs on truncated input. Not worth it
  while ~5.8 ms of headroom remains.
- **Workers Paid ($5/mo, 30 s CPU).** Still the real fix if the site outgrows this.

## Consequences

**Won**: long replies complete; headroom survives a chattier upstream (a 4× larger chunk
takes full parse from 7.02 ms to 15.94 ms but the fast path only to 4.95 ms); both fixes
are independent and either can be reverted alone.

**Paid**: a second parsing path on the hot route, i.e. a shape the upstream could drift
away from — mitigated by conservative bail-out, 16 unit tests (escapes, emoji, injection,
`usage`/`error` downgrade, `lastIndex` reset, truncation) and an end-to-end escape test
through the real streaming loop. `fastsse.ts` hard-codes OpenAI-compatible field names, so
a new provider kind needs either a matching fast path or an entry in the `slowKind` guard.

## Diagnostic playbook

When a stream truncates silently, in this order:

1. `npx wrangler tail` and reproduce with a **long** reply — `Exceeded CPU Limit` appears
   nowhere else. Do not start from timeouts: `waitUntil`'s 30 s begins when the response
   body ends, and a 69 s stream was measured completing normally.
2. **Check traffic before optimizing cost.** `/api-docs` was measured re-rendering 26 730
   characters of Markdown per request (4.19 ms) and was optimized to build-time prerender
   (`9559dca`) — then `visits` showed **0 hits in 7 days**. Correct fix, irrelevant route.
   `SELECT path, COUNT(*) FROM visits` first, `req_log WHERE svc='pg'` for the stream path.
3. Suspect anything executed **once per token**. Cost proportional to reply length is the
   signature: short replies fine, long replies dead.

---

**中文摘要**：免費方案每次呼叫只有 **10ms CPU**，超過 Cloudflare 直接殺 isolate —— 不是拋錯，
是拔電源，所以 D1 沒寫、`{done}` 沒送、連錯誤日誌都沒有，從站內任何紀錄看都像沒事發生。
**唯一看得到的地方是 `wrangler tail`。**

一波三折的過程（留著避免再犯）：
① 先誤判是 `/logs` 的總對話紀錄分頁，revert 了兩次 —— 那是純讀取的管理員 API，跟串流毫無交集。
② 再懷疑逾時／`waitUntil` —— 也錯，`waitUntil` 的 30 秒是從回應主體結束才起算，實測 69 秒串流正常。
③ 真兇之一：**每筆增量各送一次 SSE**（實測 691 次寫入）→ 批次合併 100ms／1000 字（`c3c4e4a`）。
④ 仍在爆。量到 `/api-docs` 每次請求 4.19ms 很貴就先動手優化，**結果查流量發現它七天 0 次瀏覽** ——
　 修對了但修錯地方。**教訓：先查流量、再量成本。**
⑤ 真兇之二：**每筆增量各做一次 `JSON.parse`**（9.01ms 裡的 7.02ms）。貴的不是掃位元組，是
　 V8 要建整棵物件樹 —— 每筆配置 4 物件＋13 字串，一次長回覆約 10 萬個短命物件，
　 **而 GC 暫停也計入 CPU 額度**，等於付兩次錢。

解法 `lib/fastsse.ts`：正則定位後只對那一小段做 `JSON.parse('"'+raw+'"')`，V8 只配置一個字串。
反跳脫仍交給原生 parser（`\uXXXX`、emoji surrogate pair 免手刻）。**有疑慮就放棄**：
`"error"`／`"usage":{`／`content:null`／截斷一律回 `null` 交回完整解析。
⚠️ 判斷用 `"usage":{` 不能用 `usage` —— 有些上游每筆都附 `"usage":null`，寬鬆比對會讓每筆都降級。

**兩座山是同一個形狀：「每個 token 做一次某件事」。** 只要成本跟回覆長度成正比，遲早撞牆；
第一次修完只是把牆推遠，沒換掉那個正比關係，所以長回覆照樣死。
**往後在串流迴圈裡加任何一行，先問：這行會跑幾千次嗎？**

沒採用純水管（`new Response(up.body, up)`）：零 CPU 但會洩漏上游身分、且對話存不進 D1 ——
等於把這次要救的總對話紀錄變成空的。真的不夠用時，正解是升級 Workers Paid（$5/月、30 秒 CPU）。
