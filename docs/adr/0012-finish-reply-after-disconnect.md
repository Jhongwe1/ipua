# ADR-0012: Finishing the reply after the client disconnects

**Status**: accepted · **Date**: 2026-07-21

## Context

`POST /api/playground/chat` accumulates the assistant reply in memory and writes it to D1
**once, after the stream loop ends**. Nothing is persisted mid-flight, so anything that kills
the request before that write loses the entire reply.

A member reported: ask a question, close the tab while the reasoning model is still thinking,
come back — the conversation contains the question and nothing else. Reasoning traffic makes
this the common case, not a corner case: the GLM-4.7 sample in ADR-0011 emitted **691 deltas
of which 627 were `reasoning_content`** (946 characters of thinking against 79 of answer).
The thinking phase is both the longest part of the wait and the part that persists nothing —
exactly when a member gives up and closes the tab.

The code *appeared* to handle this. `send()` caught write failures and set a `gone` flag that
broke the read loop and saved the partial reply. **That mechanism never worked**, and the
first attempt at this ADR was written on top of the same wrong assumption.

### What actually happens (measured, not reasoned)

When the client disconnects, **Cloudflare does not cancel the response stream**. Nobody reads
the readable end, backpressure never clears, and `writer.write()` **neither resolves nor
rejects — it never returns**. The loop parks on `await`, `gone` is never set, and the runtime
eventually kills the request:

```
outcome = canceled
Error: The Workers runtime canceled this request because it detected that your
       Worker's code had hung and would never generate a response.
```

Same power-cut as an ADR-0011 CPU overrun: the D1 batch, `req_log` and `errlog` all die with
it, so nothing in the application's own records shows the failure. Only `wrangler tail` sees
it. Reproduced live: conversation 180 has the user row and no assistant row.

Three live runs on the deployed Worker, disconnecting ~2 s in:

| Run | Config | Result |
|-----|--------|--------|
| conv 180 | before fix | `canceled` (hung), **nothing saved** |
| conv 181 | hang guard + 20 s budget | clean finish at D+27 s, 678 chars, `req_log` written |
| conv 182 | hang guard + 120 s budget | `canceled` at the ceiling, **1798 chars saved by checkpoints**, no `req_log` |

`request.signal` is present on the incoming Request and its `abort` event **never fires** —
instrumented in production, only the write-timeout probe ever printed. It cannot be the
detector.

The ceiling is real and its message is distinct from the hang:

```
waitUntil() tasks did not complete within the allowed time after invocation end
and have been cancelled.
```

confirming ADR-0011's "30 s from when the response body ends" — and that a disconnect *is*
the body ending.

## Decision

**Detect the disconnect with a write timeout, then keep reading in the background under a
budget, checkpointing as we go.** Timeline, `D` = the moment the tab closes:

```
D+0     client gone; no notification, stream not cancelled
D+5s    hangMs fires → treated as disconnected, budget starts
D+25s   budgetMs expires → stop reading, save
D+27s   final batch committed (assistant content + conversation + req_log)
D+30s   ← ceiling: waitUntil cancelled
```

- **`hangMs = 5000`** — a single write blocked this long means nobody is reading. Deliberately
  *not* lowered: a genuinely connected client on a bad mobile link could stall one flush for a
  few seconds, and a false positive freezes their live stream (the reply still lands in D1, so
  a reload recovers it). Buying a few seconds of generation with the live-viewer experience is
  a bad trade.
- **`budgetMs = 20000`** — measured from detection, leaving ~3 s for the final batch inside the
  ceiling. Not optional: the 120 s run proves an unbounded loop reaches the ceiling and loses
  the whole final batch.
- **`ckMs = 3000`** — the safety line for exactly that case. Conv 182 was killed with no final
  batch and still kept 1798 characters purely from checkpoints. The interval is how many
  seconds of text a kill can cost, hence 3 s. One row: `INSERT` once, then `UPDATE`. The first
  checkpoint ignores the interval (`lastCk` starts at `-ckMs`) so content is durable from the
  first delta after a disconnect.

### CPU is not the constraint here

The instinct after ADR-0011 is that reading a long reply to completion risks the 10 ms budget.
It does not: `send()` returns immediately once `gone`, and `push()` early-returns, so every
`JSON.stringify`, `TextEncoder.encode` and stream write disappears. **Background completion is
strictly cheaper in CPU than the same reply watched to the end** — the worst case for the
budget is unchanged. The per-delta check is written `gone && (await bgStop())` so the common
path costs one boolean and allocates no promise, per ADR-0011's rule.

## Rejected alternatives

- **`request.signal` as the detector.** Measured dead (see above). Kept in the code as a
  zero-cost fast path if Cloudflare ever delivers it, explicitly annotated so nobody removes
  `hangMs` believing the signal works.
- **Unbounded continuation.** Measured: reaches the ceiling, loses the final batch.
- **Checkpoints only, no continuation.** Doesn't fix the motivating case — while the model is
  thinking there is nothing to checkpoint.
- **Durable Object or Queues owning the generation.** The correct answer for durations past
  30 s, and DO is already a dependency (ADR-0007). Disproportionate here: a new persistence
  path and lifecycle against ADR-0002's single-D1 premise.

## Consequences

**Won**: closing the tab mid-thought now persists the reply instead of losing it entirely.
Conv 180 (nothing) → conv 181 (678 chars, clean) / conv 182 (1798 chars via checkpoints).

**Paid**:

- **Replies longer than ~25 s of post-disconnect generation are still truncated.** The 30 s
  ceiling is a platform limit, not a tuning choice — the test prompt ("full pig-blood-cake
  recipe") was still generating at 1798 characters. Recorded in DEBT; the real fixes are
  Workers Paid or moving generation into a Durable Object.
- **The stop button is indistinguishable from a page close** — both are just an aborted fetch,
  and the disconnect is only detected by a timeout, so pressing stop also finishes the reply in
  the background. Recorded in DEBT; fixing it needs an explicit abort signal from the frontend.
- Upstream tokens are spent on replies nobody reads.

---

**中文摘要**：回覆是**整段收完才一次寫 D1**，中途什麼都不落地。會員在推理模型思考時關掉
分頁，正文一個字都還沒生成 → D1 連 assistant 那列都沒有。而 ADR-0011 量到的 GLM-4.7 是
**691 筆增量裡 627 筆是思考**，所以這是常態不是邊角。

**原本以為有處理，其實那套機制從來沒作用過**（本 ADR 第一版也是建立在同一個錯誤前提上）。
實測真相：客戶端離線時 **Cloudflare 不會取消回應串流**，沒人讀 → 背壓不解除 →
`writer.write()` 既不成功也不失敗，就是永遠不回來。程式卡在 `await`，最後整個請求被判定
`code had hung and would never generate a response` 而 canceled ——
D1、req_log、errlog 全部陪葬，站內零痕跡，**只有 `wrangler tail` 看得到**。

線上實測三次（都在 2 秒時斷線）：

| 對話 | 設定 | 結果 |
|---|---|---|
| 180 | 修復前 | canceled（死鎖），**什麼都沒存** |
| 181 | 逾時偵測＋20 秒預算 | D+27 秒乾淨收工，678 字，req_log 有 |
| 182 | 逾時偵測＋120 秒預算 | 撞天花板被砍，**靠階段性存檔留下 1798 字**，req_log 沒有 |

`request.signal` **實測不會觸發**（上探針到線上，只等到寫入逾時那一發），所以偵測只能靠
**寫入逾時**。天花板也實測到了，訊息與死鎖那個不同：
`waitUntil() tasks did not complete within the allowed time after invocation end`。

**三個常數**（D＝關掉分頁的時刻）：`hangMs=5s` 判定斷線（刻意不再壓低，避免誤判爛網路的
線上使用者）→ `budgetMs=20s` 收工 → D+27 秒收尾寫完 → D+30 秒天花板。
`ckMs=3s` 是撞天花板時的保命索 —— 182 那次收尾完全沒跑，1798 字全靠它。

**CPU 不是這裡的阻力**（與直覺相反）：`gone` 之後 `send()` 直接 return，stringify／編碼／
寫串流整組消失，背景跑完比「會員看著跑完」還省。

**沒解決的**：超過約 25 秒生成時間的長回覆仍會被截斷 —— 那是平台的 30 秒天花板，不是參數
調得動的。真正的解是 Workers Paid 或把生成搬進 Durable Object，記在 DEBT。
