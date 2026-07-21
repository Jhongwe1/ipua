# ADR-0012: Finishing the reply after the client disconnects

**Status**: accepted · **Date**: 2026-07-21

## Context

`POST /api/playground/chat` accumulates the assistant reply in memory and writes it to D1
**once, after the stream loop ends**. Nothing is persisted mid-flight.

Until now a browser disconnect (closing the tab, or the stop button) set `gone`, broke the
read loop and cancelled the upstream, saving whatever had accumulated. For a member who
closes the page **while a reasoning model is still thinking**, that is not a truncated
reply — it is **no reply at all**: `full` is still empty, so `if (full)` skips the INSERT
entirely and the conversation contains the question and nothing else.

Reasoning traffic makes this the common case rather than the corner case. The GLM-4.7
sample measured in ADR-0011 emitted **691 deltas, of which 627 were `reasoning_content`**
(946 characters of thinking against 79 of answer). The thinking phase is both the longest
part of the wait and the part that persists nothing — exactly when a member gives up and
closes the tab.

## Decision

**A disconnect no longer cancels generation.** The loop keeps reading inside `waitUntil`
and persists the complete reply, bounded by two constants (`BG` in `chat.ts`).

### CPU is not the objection here

The instinct after ADR-0011 is that reading a long reply to completion risks the 10 ms
budget. It does not, because the write side is already conditional:

```js
function send(obj) { if (gone) return Promise.resolve(); … }
```

Once `gone`, every `JSON.stringify`, `TextEncoder.encode` and stream write disappears, and
`push()` early-returns so the accumulate/flush bookkeeping goes with it. **Finishing in the
background is strictly cheaper in CPU than the same reply watched to the end.** The worst
case for the budget is unchanged: a long reply with a member watching, which ADR-0011
already sized for.

The new per-delta check is written `gone && (await bgStop())` so the common path costs one
boolean and allocates no promise — ADR-0011's rule is that anything in this loop runs
thousands of times.

### The real constraint is wall clock

`waitUntil`'s 30 s begins when the **response body ends** (ADR-0011, playbook step 1) — and
a disconnect ends it. Reading past that window gets the isolate killed, which is the same
power-cut as a CPU overrun: the D1 write never happens. Unbounded continuation would
therefore be **worse than doing nothing**, trading a partial reply for none at all.

- **`budgetMs = 20000`** — measured `req_log` duration is **avg 11 452 ms, max 75 107 ms**
  for the whole request, and a disconnect usually lands mid-reply so the remaining time is
  shorter still. 20 s finishes the large majority and leaves 10 s of margin for the final
  D1 batch. On exhaustion the loop breaks and saves what it has, so **the floor is the old
  behaviour** — this change cannot lose data the previous one would have kept.
- **`ckMs = 5000`** — the 30 s figure is *inferred* for the disconnect case: it was measured
  on a stream that completed normally (69 s, client attached), not on a disconnect. A
  checkpoint every 5 s of background time (one row: INSERT once, then UPDATE) caps the cost
  of that inference being wrong at 5 s of text instead of the entire reply.
  The **first** checkpoint is not on that schedule — `lastCk` starts at `-ckMs` so the first
  content seen after a disconnect is written immediately. Without it the floor claim above
  is false: the old code persisted at the moment of disconnect, so a kill at 3 s would have
  lost text the old code kept. Starting the interval at zero would have made this a
  regression rather than a trade-off.

## Rejected alternatives

- **Unbounded continuation.** Simplest to write, but the power-cut mode makes it strictly
  worse than the behaviour it replaces.
- **Checkpoints only, no continuation.** Cheaper, and it does fix truncation — but not the
  case that motivated this ADR: while the model is thinking there is nothing to checkpoint.
- **Durable Object or Queues owning the generation.** The correct answer for arbitrary
  durations, and DO is already a dependency (ADR-0007). Rejected as disproportionate: a new
  persistence path and lifecycle against ADR-0002's single-D1 premise, to serve replies
  that run more than 20 s past a disconnect.
- **Workers Paid.** Raises the CPU ceiling, which is not what binds here.

## Consequences

**Won**: closing the tab mid-thought now yields the complete answer on the next visit —
the reason the conversation history exists at all.

**Paid**:

- **The stop button is indistinguishable from a page close** at the server: both are an
  aborted fetch. Pressing stop now also finishes the reply in the background, so history
  shows the complete answer while the on-screen bubble kept the truncated text. Recorded in
  DEBT — an explicit abort signal is the fix, and it costs a new endpoint plus its
  three-place doc sync (ADR-0010).
- Upstream tokens are spent on replies nobody reads.
- Replies still running 20 s after a disconnect are truncated, as before.

---

**中文摘要**：以前瀏覽器一斷線就掐斷上游 —— 會員在**推理模型還在思考時**關掉網頁，正文
一個字都還沒生成，`if (full)` 直接跳過 INSERT，D1 連 assistant 那列都沒有，下次打開只剩
自己問的問題。而 ADR-0011 量到的 GLM-4.7 是 **691 筆增量裡 627 筆是思考**，思考階段既
最久、又什麼都存不下 —— 正好是會員放棄等待的時刻，所以這是常態不是邊角。

**改成：斷線不中斷生成，背景讀完再存。**

CPU 不是這裡的阻力（這點與直覺相反）：`send()` 一開頭就是 `if (gone) return`，斷線後
stringify、編碼、寫串流整組消失，`push()` 也直接 return —— **背景跑完花的 CPU 一定比
「會員看著跑完」少**，ADR-0011 的最壞情況沒有變。迴圈裡寫成 `gone && (await bgStop())`，
沒斷線時被短路，連 promise 都不配置。

真正的牆是**時鐘不是 CPU**：`waitUntil` 的 30 秒從「回應主體結束」起算，而斷線就是結束。
讀過頭 isolate 被拔電源，D1 一樣寫不進去 —— **無上限續跑會比原本更糟**（本來至少存得到半截）。
所以 `budgetMs=20000`（實測整趟平均 11.4 秒／最長 75.1 秒，斷線多在中途、剩餘更短；
留 10 秒給最後那次 batch），時間到就收工存檔，**最壞等於舊行為**。
`ckMs=5000` 是對「30 秒」這個推論的保險 —— 那個數字是在**正常跑完**的串流上量到的，
不是在斷線上，萬一前提錯了，損失從「整趟」變成「最後 5 秒」。
但**第一次存檔不照這個間隔**：`lastCk` 初值設成 `-ckMs`，斷線後只要有內容就立刻先存一次。
少了這一步，上面那句「最壞等於舊行為」就是假的 —— 舊行為是斷線當下就存，若第一次要等
5 秒而 isolate 在第 3 秒被拔電源，新版反而丟掉舊版存得到的東西，那是倒退不是取捨。

**代價**：伺服器分不出「關網頁」和「按停止」（都是 fetch 被中止），所以按停止也會在背景
跑完，歷史紀錄會出現完整回覆、畫面上卻停在截斷處 —— 記進 DEBT。另外沒人看的回覆一樣要
付上游 token。
