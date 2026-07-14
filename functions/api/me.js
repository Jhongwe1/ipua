// GET /api/me — 回報「我是誰」（給右上角帳號鈕與 /relay、/vpn、/playground 頁用）。
// 沒登入回 { user: null }；有登入回自己的資料（不含任何金鑰明文）。
// services＝被批准的服務清單（分服務批准；站長固定是全部）。
// pg_open 全員開放打開時，services 會多出 playground — 前端閘門靠這個清單放行。
import { getSessionUser, isAdminUser, isApproved, userServices, canUsePlayground, json } from "../../lib/auth.js";
import { usageSummary } from "../../lib/quota.js";
import { canSeeVpn } from "../../lib/chrome.js";

export async function onRequestGet({ request, env }) {
  const user = await getSessionUser(request, env);
  if (!user) return json({ user: null });
  const services = userServices(user, env);
  if (services.indexOf("playground") < 0 && await canUsePlayground(user, env)) services.push("playground");
  // 今日用量摘要（只含有權限的服務；站長 limit=null＝無上限；沒權限＝整塊省略）
  const usage = await usageSummary(env, user, services);
  return json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      picture: user.picture,
      status: user.status,
      is_admin: isAdminUser(user, env),
      approved: isApproved(user, env),
      services: services,
      has_key: !!user.api_key_hash,
      key_hint: user.api_key_hint || "",
      key_at: user.api_key_at || null,
      // VPN 隱形（2026-07-14）：無 vpn 權限者連欄位都不出現（JSON.stringify 會丟掉 undefined）
      vpn_token: canSeeVpn(user, env) ? (user.vpn_token || "") : undefined,
      vpn_pulls: canSeeVpn(user, env) ? (user.vpn_pulls || 0) : undefined,
      relay_calls: user.relay_calls || 0,
      usage: usage || undefined
    }
  });
}
