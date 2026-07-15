// POST /auth/logout — 登出：刪掉伺服器上的 session、清掉瀏覽器 cookie。
// 用 POST（由帳號選單的按鈕送出）＋ Origin 檢查，別站放個連結騙不到。
import { deleteSession, clearSessionCookies, goodOrigin, json } from "../../lib/auth.js";

export async function onRequestPost({ request, env }) {
  const url = new URL(request.url);
  if (!goodOrigin(request, url, env)) return json({ error: "bad-origin" }, 403);
  await deleteSession(request, env);
  const headers = new Headers({ Location: "/", "cache-control": "no-store" });
  clearSessionCookies(url).forEach(function (c) { headers.append("Set-Cookie", c); });
  return new Response(null, { status: 303, headers: headers });
}

// 有人直接在網址列打 /auth/logout → 不做事，回首頁
export function onRequestGet() {
  return new Response(null, { status: 302, headers: { Location: "/" } });
}
