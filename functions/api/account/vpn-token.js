// POST /api/account/vpn-token — 重新產生自己的 VPN 訂閱網址代碼。
// 舊的訂閱網址立即失效（訂閱網址外流時自救用）。要登入（cookie）。
import { getSessionUser, goodOrigin, randToken, json } from "../../../lib/auth.js";

export async function onRequestPost({ request, env }) {
  const url = new URL(request.url);
  if (!goodOrigin(request, url, env)) return json({ error: "bad-origin" }, 403);
  const user = await getSessionUser(request, env);
  if (!user) return json({ error: "unauthorized", hint: "請先登入" }, 401);
  if (user.status === "blocked") return json({ error: "blocked" }, 403);

  const token = randToken("uvt", 20);
  try {
    await env.DB.prepare("UPDATE users SET vpn_token=?1 WHERE id=?2").bind(token, user.id).run();
    return json({ vpn_token: token, note: "舊的訂閱網址已失效，記得更新你 App 裡的訂閱。" });
  } catch (e) {
    return json({ error: "save-failed", detail: String(e && e.message || e) }, 500);
  }
}
