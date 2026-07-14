# ADR-0005: Relay metering via pump, not tee()

**Status**: accepted · **Date**: 2026-07-14

## Context

v1.0.0 adds metering to the relay: token usage and model name must be extracted from
upstream responses (often SSE streams) without breaking passthrough fidelity. The obvious
implementation is `response.body.tee()` — one branch to the client, one branch scanned in
`waitUntil`.

## Decision

**No tee().** A single reader **pumps** the upstream: read a chunk → write it to the client
through a TransformStream → append to a 64 KB sliding text window. When the stream ends,
regex-scan the window for the *last* `"model"` / token-count fields (OpenAI, Anthropic and
Gemini field names all recognized) and write one `req_log` row.

Key behaviors:

- **Client disconnect**: the write to the client rejects → we immediately
  `reader.cancel()` the upstream. With `tee()`, the surviving branch would keep reading,
  which keeps the upstream **generating tokens we pay for** after the member left.
- **Request privacy**: only the *response* is scanned. Member request bodies are never
  buffered or parsed (also the reason the scanner is a regex over text, not a JSON parser).
- **Escape hatch**: settings `relay_meter='0'` reverts to the pre-v1 pure passthrough with
  zero deploys; pump construction failure falls back likewise.
- The playground already used this pattern (chat.js) — the relay reuses a proven shape.

## Consequences

**Won**: no double-buffering of large streams; upstream cancellation is immediate and
correct; metering cost is one TextDecoder + one regex over ≤64 KB per request.

**Paid**: metering sits on the hot path (bug risk mitigated by byte-fidelity tests, the
kill switch, and fetch-failure fallbacks); usage appearing only in the final 64 KB is an
assumption — true for all three providers today, revisit if a provider streams usage early
in giant responses; non-UTF-8 binary responses pass through fine but scan as garbage
(harmless: fields simply not found).

---

**中文摘要**：不用 tee() — 客戶端斷線時 tee 的另一支會把上游讀完＝上游繼續生成＝燒錢。
改用單一 reader 的 pump：讀一塊→寫給客戶端→進 64KB 滑動窗；結束時 regex 掃最後的
model／token 欄位（三家欄位名都認）寫一列 req_log。寫入失敗立即 cancel 上游；
只掃「回應」、絕不緩衝會員請求；settings relay_meter='0' 是免部署的退路。
代價：計量在熱路徑上（用位元組保真測試＋開關對沖）、假設 usage 在最後 64KB 內。
