// /api/account/key — 會員自己的 API 金鑰（uak-…，用在 API 中轉站）。
//   POST   產生新金鑰（舊的立即失效）。明文只在這次回應出現一次，資料庫只存 SHA-256。
//   DELETE 撤銷金鑰。
// 要登入（cookie）。待核准的帳號也能先產生金鑰，但中轉端點會擋到核准為止。
import {
  getSessionUser, goodOrigin, randToken, sha256hex, keyHint, json
} from "../../../lib/auth.js";

export async function onRequestPost({ request, env }) {
  const url = new URL(request.url);
  if (!goodOrigin(request, url, env)) return json({ error: "bad-origin" }, 403);
  const user = await getSessionUser(request, env);
  if (!user) return json({ error: "unauthorized", hint: "請先登入" }, 401);
  if (user.status === "blocked") return json({ error: "blocked" }, 403);

  const key = randToken("uak-", 26);
  const now = new Date().toISOString();
  try {
    await env.DB.prepare(
      "UPDATE users SET api_key_hash=?1, api_key_hint=?2, api_key_at=?3 WHERE id=?4"
    ).bind(await sha256hex(key), keyHint(key), now, user.id).run();
    return json({ key: key, key_hint: keyHint(key), key_at: now,
                  note: "金鑰只顯示這一次，請立刻複製保存；舊金鑰已失效。" });
  } catch (e) {
    return json({ error: "save-failed", detail: String(e && e.message || e) }, 500);
  }
}

export async function onRequestDelete({ request, env }) {
  const url = new URL(request.url);
  if (!goodOrigin(request, url, env)) return json({ error: "bad-origin" }, 403);
  const user = await getSessionUser(request, env);
  if (!user) return json({ error: "unauthorized" }, 401);
  try {
    await env.DB.prepare(
      "UPDATE users SET api_key_hash='', api_key_hint='', api_key_at=NULL WHERE id=?1"
    ).bind(user.id).run();
    return json({ ok: true });
  } catch (e) {
    return json({ error: "save-failed", detail: String(e && e.message || e) }, 500);
  }
}
