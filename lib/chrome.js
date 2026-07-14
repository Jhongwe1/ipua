// @ts-check
// lib/chrome.js — 頁面外殼（選單＋站名）的「身分感知」版本（2026-07-14 VPN 隱形）。
//
// 拍板：VPN 對「非站長且未被批准 vpn 服務」的人**完全隱形** —
//   1. 側邊欄選單不渲染 VPN 項（這裡的 filterMenu）
//   2. /vpn 頁面裝成不存在（functions/vpn/index.js 回靜態 SPA，跟打不存在路徑一樣）
//   3. /api/me 不吐 vpn_token / vpn_pulls 欄位
//
// 獨立成一檔是為了避免 lib/site.js ↔ lib/auth.js 循環 import
//（site 不能 import auth：auth 已經 import site 的 json/securityHeaders）。
import { getChrome } from "./site.js";
import { getSessionUser, hasService, isAdminUser } from "./auth.js";

/**
 * 純函式：非授權者濾掉 url 是 /vpn 或 /vpn/ 開頭的選單項（D1 自訂選單與內建預設都適用）。
 * @param {Array<{kind:string,label:string,label_en?:string,url?:string}>} menu
 * @param {boolean} showVpn
 */
export function filterMenu(menu, showVpn) {
  if (showVpn) return menu;
  return menu.filter(function (it) {
    const u = String((it && it.url) || "");
    return !(u === "/vpn" || u.indexOf("/vpn/") === 0);
  });
}

/**
 * 這個訪客看不看得到 VPN（站長或有 vpn 服務才看得到）。
 * @param {any} user @param {any} env
 */
export function canSeeVpn(user, env) {
  return !!user && (isAdminUser(user, env) || hasService(user, env, "vpn"));
}

/**
 * getChrome 的身分感知版：一次拿回（過濾後的）外殼與登入中的會員。
 * 匿名訪客在 getSessionUser 的 cookie 格式檢查就短路 → 零額外 D1 查詢，
 * SSR 效能與原本的 getChrome 相同；有登入才多一次 session JOIN 查詢。
 * @param {any} env
 * @param {Request} request
 * @returns {Promise<{chrome:{brand:string,menu:any[],custom:boolean}, user:any}>}
 */
export async function getChromeFor(env, request) {
  const [chrome, user] = await Promise.all([
    getChrome(env),
    getSessionUser(request, env)
  ]);
  return {
    chrome: {
      brand: chrome.brand,
      custom: chrome.custom,
      menu: filterMenu(chrome.menu, canSeeVpn(user, env))
    },
    user: user
  };
}
