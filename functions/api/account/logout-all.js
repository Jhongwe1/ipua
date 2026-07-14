// POST /api/account/logout-all — 登出所有裝置（會員自助）。
// 把自己的 session 全刪（包含現在這一把），並清掉本裝置的 cookie。
// 用途：手機不見了、在公用電腦忘了登出 — 一鍵讓所有登入狀態失效。
import { json } from "../../../lib/site.js";
import { getSessionUser, goodOrigin, clearSessionCookies } from "../../../lib/auth.js";

export async function onRequestPost({ request, env }) {
  const url = new URL(request.url);
  if (!goodOrigin(request, url)) return json({ error: "bad-origin" }, 403);
  const user = await getSessionUser(request, env);
  if (!user) return json({ error: "unauthorized", hint: "請先登入" }, 401);
  try {
    await env.DB.prepare("DELETE FROM sessions WHERE user_id=?1").bind(user.id).run();
  } catch (e) {
    return json({ error: "save-failed", detail: String(e && e.message || e) }, 500);
  }
  const headers = new Headers({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  clearSessionCookies(url).forEach(function (c) { headers.append("Set-Cookie", c); });
  return new Response(JSON.stringify({ ok: true }), { headers: headers });
}
