// GET /openapi.json — OpenAPI 3.1 規格（公開；v2.0.0 Phase L，ADR-0010）。
// 內容是 tools/build-openapi.mjs 從 docs/openapi.yaml 編出來的 JSON 模組 — 不即時解析 YAML，
// worker 維持零執行期依賴。/api-docs 的互動式參考（vendored Scalar）也吃這個端點。
import { OPENAPI } from "../lib/openapi.js";
import type { RouteCtx } from "../types.js";

export function onRequestGet(_ctx: RouteCtx): Response {
  return new Response(JSON.stringify(OPENAPI), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=300" // 規格不常變，給 5 分鐘邊緣/瀏覽器快取
    }
  });
}
