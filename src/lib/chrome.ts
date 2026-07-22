// src/lib/chrome.ts — 頁面外殼（選單＋站名）的「身分感知」版本（2026-07-14 VPN 隱形）。
//
// 拍板：VPN 對「非管理員且未被批准 vpn 服務」的人**完全隱形** —
//   1. 側邊欄選單不渲染 VPN 項（這裡的 filterMenu）
//   2. /vpn 頁面裝成不存在（src/routes/vpn/index.ts 回靜態 SPA，跟打不存在路徑一樣）
//   3. /api/me 不吐 vpn_token / vpn_pulls 欄位
//
// 獨立成一檔是為了避免 site ↔ auth 循環 import
//（site 不能 import auth：auth 已經 import site 的 json/securityHeaders）。
import { getChrome, type Chrome, type MenuItem } from "./site.js";
import { getSessionUser, hasService, isAdminUser, type SessionUser } from "./auth.js";
import type { Env, UserRow } from "../types.js";

/** 純函式：非授權者濾掉 url 是 /vpn 或 /vpn/ 開頭的選單項（D1 自訂選單與內建預設都適用）。 */
export function filterMenu(menu: MenuItem[], showVpn: boolean): MenuItem[] {
  if (showVpn) return menu;
  return menu.filter(function (it) {
    const u = String((it && it.url) || "");
    return !(u === "/vpn" || u.indexOf("/vpn/") === 0);
  });
}

/** 這個訪客看不看得到 VPN（管理員或有 vpn 服務才看得到）。 */
export function canSeeVpn(user: UserRow | null | undefined, env: Env): boolean {
  return !!user && (isAdminUser(user, env) || hasService(user, env, "vpn"));
}

/**
 * getChrome 的身分感知版：一次拿回（過濾後的）外殼與登入中的會員。
 * 匿名訪客在 getSessionUser 的 cookie 格式檢查就短路 → 零額外 D1 查詢，
 * SSR 效能與原本的 getChrome 相同；有登入才多一次 session JOIN 查詢。
 */
export async function getChromeFor(
  env: Env,
  request: Request
): Promise<{ chrome: Chrome; user: SessionUser | null }> {
  const [chrome, user] = await Promise.all([getChrome(env, request), getSessionUser(request, env)]);
  return {
    chrome: {
      brand: chrome.brand,
      custom: chrome.custom,
      vpnPublic: chrome.vpnPublic,
      // v2.2：管理員可開 vpn_public（settings）讓 VPN 對外展示 — 開著就不過濾
      menu: filterMenu(chrome.menu, chrome.vpnPublic || canSeeVpn(user, env))
    },
    user: user
  };
}
