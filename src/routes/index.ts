// GET / — 根網址改跳 Playground（2026-07-14 管理員要求）。
// 用 Function 跳轉而不是 _redirects：在 _redirects 對「/」設規則會弄壞 SPA fallback
//（/ip、/ua 會變 404，實測踩過）。IP·UA 工具改由 /ip、/ua 進入（SPA fallback 回 index.html）。
// 302（暫時性）方便日後改回工具當首頁。
import type { RouteCtx } from "../types.js";

export function onRequestGet({ request }: RouteCtx): Response {
  const url = new URL(request.url);
  return Response.redirect(url.origin + "/playground", 302);
}
