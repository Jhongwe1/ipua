// GET /api/me — 回報「我是誰」（給右上角帳號鈕與 /relay、/vpn、/playground 頁用）。
// 沒登入回 { user: null }；有登入回自己的資料（不含任何金鑰明文）。
// services＝被批准的服務清單（分服務批准；站長固定是全部）。
import { getSessionUser, isAdminUser, isApproved, userServices, json } from "../../lib/auth.js";

export async function onRequestGet({ request, env }) {
  const user = await getSessionUser(request, env);
  if (!user) return json({ user: null });
  return json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      picture: user.picture,
      status: user.status,
      is_admin: isAdminUser(user, env),
      approved: isApproved(user, env),
      services: userServices(user, env),
      has_key: !!user.api_key_hash,
      key_hint: user.api_key_hint || "",
      key_at: user.api_key_at || null,
      vpn_token: user.vpn_token || "",
      relay_calls: user.relay_calls || 0,
      vpn_pulls: user.vpn_pulls || 0
    }
  });
}
