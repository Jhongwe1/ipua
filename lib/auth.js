// lib/auth.js — Google 登入、session、會員金鑰、站長驗證的共用程式（2026-07-11 上線）。
//
// 兩套身分並存：
//   1. 管理金鑰（LOGS_TOKEN，Authorization: Bearer）— 給 curl／AI agent 用，行為不變。
//   2. Google 登入 session（HttpOnly cookie ipua_sess）— 給瀏覽器用；
//      站長信箱登入後，管理頁與站長 API 免金鑰直接用（adminOk 兩者都收）。
//
// 環境變數（wrangler pages secret put …）：
//   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET — Google OAuth 憑證（沒設定時登入功能顯示「尚未開通」）
//   ADMIN_EMAILS — 站長信箱清單（逗號分隔）；沒設定＝沒有信箱直升站長，只認 users.is_admin
import { json, securityHeaders, siteOrigin } from "./site.js";

export const SESSION_DAYS = 30;          // 登入狀態保留天數
const SESS_COOKIE = "ipua_sess";         // HttpOnly：session 編號（伺服器才讀得到）
const HINT_AUTH = "ipua_auth";           // 非 HttpOnly 提示：有登入 → 前端才去打 /api/me
const HINT_ADM = "ipua_adm";             // 非 HttpOnly 提示：是站長 → 前端才載入 adminbar.js

export function adminEmails(env) {
  return String((env && env.ADMIN_EMAILS) || "")
    .toLowerCase().split(",").map(function (s) { return s.trim(); }).filter(Boolean);
}

export function isLocal(url) {
  return url.hostname === "localhost" || url.hostname === "127.0.0.1";
}

/* ===== 小工具 ===== */

// 亂數代碼：小寫 base32（a-z2-7），256 % 32 === 0 所以取餘數不會偏斜
export function randToken(prefix, len) {
  const abc = "abcdefghijklmnopqrstuvwxyz234567";
  const buf = new Uint8Array(len || 26);
  crypto.getRandomValues(buf);
  let s = "";
  for (let i = 0; i < buf.length; i++) s += abc[buf[i] % 32];
  return (prefix || "") + s;
}

export async function sha256hex(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(s)));
  return Array.from(new Uint8Array(d)).map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");
}

// 管理金鑰比對：兩邊各自 sha256 後再比 — 雜湊後長度固定且內容不可逆推，
// 字串比對的提前結束不再洩漏金鑰前綴（constant-time 等效、零依賴）。
export async function tokenEqual(a, b) {
  if (!a || !b) return false;
  return (await sha256hex(a)) === (await sha256hex(b));
}

// 金鑰顯示提示：uak-abcd…wxyz（明文不落地，資料庫只存雜湊）
export function keyHint(key) {
  const k = String(key || "");
  return k.length < 12 ? k : k.slice(0, 8) + "…" + k.slice(-4);
}

export function getCookie(request, name) {
  const c = request.headers.get("cookie") || "";
  const m = c.match(new RegExp("(?:^|;\\s*)" + name + "=([^;]*)"));
  return m ? decodeURIComponent(m[1]) : "";
}

// 登入後跳回的網址只收站內路徑（避免被當跳板轉去外站）
export function safeNext(v) {
  const s = String(v || "");
  return /^\/(?!\/)/.test(s) ? s.slice(0, 300) : "/";
}

function cookieStr(name, value, maxAge, opts) {
  opts = opts || {};
  let s = name + "=" + encodeURIComponent(value) +
    "; Path=" + (opts.path || "/") + "; Max-Age=" + maxAge + "; SameSite=Lax";
  if (opts.httpOnly) s += "; HttpOnly";
  if (opts.secure) s += "; Secure";
  return s;
}

/* ===== session ===== */

// 建立 session：回傳 { sid(cookie 明文值), cookies[](Set-Cookie 字串) }。順手清掉過期列。
export async function createSession(env, user, url) {
  const sid = randToken("", 32);
  const now = new Date();
  const exp = new Date(now.getTime() + SESSION_DAYS * 86400e3);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?1").bind(now.toISOString()),
    env.DB.prepare("INSERT INTO sessions (sid, user_id, created_at, expires_at) VALUES (?1,?2,?3,?4)")
      .bind(await sha256hex(sid), user.id, now.toISOString(), exp.toISOString())
  ]);
  const secure = url.protocol === "https:";
  const age = SESSION_DAYS * 86400;
  const cookies = [
    cookieStr(SESS_COOKIE, sid, age, { httpOnly: true, secure: secure }),
    cookieStr(HINT_AUTH, "1", age, { secure: secure })
  ];
  if (isAdminUser(user, env)) cookies.push(cookieStr(HINT_ADM, "1", age, { secure: secure }));
  else cookies.push(cookieStr(HINT_ADM, "", 0, { secure: secure }));
  return { sid: sid, cookies: cookies };
}

export function clearSessionCookies(url) {
  const secure = url.protocol === "https:";
  return [
    cookieStr(SESS_COOKIE, "", 0, { httpOnly: true, secure: secure }),
    cookieStr(HINT_AUTH, "", 0, { secure: secure }),
    cookieStr(HINT_ADM, "", 0, { secure: secure })
  ];
}

// 由 cookie 取回登入中的會員（users 整列＋ _exp）；沒登入或過期回 null。
export async function getSessionUser(request, env) {
  if (!env || !env.DB) return null;
  const sid = getCookie(request, SESS_COOKIE);
  if (!/^[a-z2-7]{20,64}$/.test(sid)) return null;
  try {
    const row = await env.DB.prepare(
      "SELECT u.*, s.expires_at AS _exp FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.sid = ?1"
    ).bind(await sha256hex(sid)).first();
    if (!row || Date.parse(row._exp) < Date.now()) return null;
    return row;
  } catch (e) { return null; }
}

export async function deleteSession(request, env) {
  const sid = getCookie(request, SESS_COOKIE);
  if (!env || !env.DB || !sid) return;
  try {
    await env.DB.prepare("DELETE FROM sessions WHERE sid = ?1").bind(await sha256hex(sid)).run();
  } catch (e) {}
}

/* ===== 身分判斷 ===== */

export function isAdminUser(user, env) {
  if (!user || user.status === "blocked") return false;
  return user.is_admin === 1 || adminEmails(env).indexOf(String(user.email || "").toLowerCase()) >= 0;
}

// 核准過（或站長）才能用中轉／VPN 這類會花錢的功能
export function isApproved(user, env) {
  if (!user || user.status === "blocked") return false;
  return user.status === "approved" || isAdminUser(user, env);
}

/* ===== 分服務批准（2026-07-13）=====
   站長可以對每個會員「分別」批准不同服務：users.services 存逗號分隔清單。
   站長帳號不看 services、全部服務都能用；封鎖一律全擋。 */
export const SERVICES = ["relay", "vpn", "playground"];

// 這個會員被批准的服務清單（依 SERVICES 順序、只留合法值）；站長＝全部。
export function userServices(user, env) {
  if (!user || user.status === "blocked") return [];
  if (isAdminUser(user, env)) return SERVICES.slice();
  if (user.status !== "approved") return [];
  const own = String(user.services || "").split(",").map(function (s) { return s.trim(); });
  return SERVICES.filter(function (s) { return own.indexOf(s) >= 0; });
}

export function hasService(user, env, svc) {
  return userServices(user, env).indexOf(svc) >= 0;
}

/* ===== Playground 全員開放開關（2026-07-14）=====
   站長不缺 token 時可以整站開放：settings 表 pg_open='1' ＝ 任何已登入、
   未封鎖的會員都能用 playground，不必逐人批准；沒這個鍵＝關（維持逐人批准）。
   只影響 playground — relay 與 vpn 照舊看個人批准。 */
export async function pgOpenAll(env) {
  if (!env || !env.DB) return false;
  try {
    const r = await env.DB.prepare("SELECT v FROM settings WHERE k='pg_open'").first();
    return !!(r && r.v === "1");
  } catch (e) { return false; }
}

export async function canUsePlayground(user, env) {
  if (hasService(user, env, "playground")) return true;
  if (!user || user.status === "blocked") return false;
  return pgOpenAll(env);
}

// CSRF 防線（cookie 身分專用）：瀏覽器跨站送出的請求會帶 Origin 標頭，
// 不是自家網域就擋。沒有 Origin（curl、同站 GET 導覽）放行 — 那些拿不到回應或不是跨站。
// 額外放行的網域只有 env.SITE_ORIGIN（正式網址；同源之外例如反向代理／預覽域打正式 API）。
export function goodOrigin(request, url, env) {
  const o = request.headers.get("origin") || "";
  if (!o) return true;
  if (o === "null") return false;
  if (o === url.origin) return true;
  if (env && env.SITE_ORIGIN && o === siteOrigin(env, request)) return true;
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);
}

/* ===== 站長驗證（取代舊 lib/site.js 的 authed，兩種身分都收） ===== */
// 1) Authorization: Bearer <LOGS_TOKEN>（curl／agent；LOGS_TOKEN 沒設定時只有 localhost 放行）
// 2) 站長 Google 帳號的登入 cookie（瀏覽器；經過 Origin 檢查）
export async function adminOk(request, env, url) {
  const auth = request.headers.get("authorization") || "";
  const token = auth.indexOf("Bearer ") === 0 ? auth.slice(7).trim() : "";
  if (env.LOGS_TOKEN) { if (await tokenEqual(token, env.LOGS_TOKEN)) return true; }
  else if (isLocal(url)) return true;
  if (!goodOrigin(request, url, env)) return false;
  const user = await getSessionUser(request, env);
  return isAdminUser(user, env);
}

/* ===== 會員金鑰（API 中轉用） ===== */

// 從請求裡撈會員金鑰（uak-…）。各家 SDK 放金鑰的位置不同，全都收：
// Authorization: Bearer（OpenAI）、x-api-key（Anthropic）、x-goog-api-key（Gemini）、?key=（Gemini 舊式）
export function memberKeyFrom(request, url) {
  const auth = request.headers.get("authorization") || "";
  if (auth.indexOf("Bearer ") === 0) return auth.slice(7).trim();
  return (request.headers.get("x-api-key") || request.headers.get("x-goog-api-key") ||
    url.searchParams.get("key") || "").trim();
}

// 用會員金鑰換會員資料；無效回 null。
export async function userFromKey(env, key) {
  if (!env || !env.DB || !/^uak-[a-z2-7]{16,64}$/.test(key || "")) return null;
  try {
    return await env.DB.prepare("SELECT * FROM users WHERE api_key_hash = ?1")
      .bind(await sha256hex(key)).first();
  } catch (e) { return null; }
}

/* ===== 極簡獨立頁（登入流程的錯誤／提示頁；不依賴外殼，黑白風格一致） ===== */
export function miniPage(title, bodyHtml, status) {
  const html =
    '<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">' +
    '<meta name="robots" content="noindex,nofollow"><title>' + title + '</title><style>' +
    'body{font-family:-apple-system,"Segoe UI","Microsoft JhengHei",system-ui,sans-serif;background:#fff;color:#111;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:16px}' +
    '@media(prefers-color-scheme:dark){body{background:#0b0b0b;color:#f4f4f4}.card{background:#131313!important;border-color:#262626!important}input{background:#181818!important;border-color:#262626!important;color:#f4f4f4!important}a.btn,button{background:#f4f4f4!important;color:#0b0b0b!important}}' +
    '.card{border:1px solid #e6e6e6;border-radius:14px;padding:26px;max-width:400px;width:100%;background:#fff;box-sizing:border-box}' +
    'h1{font-size:18px;margin:0 0 10px}p{font-size:14px;line-height:1.7;color:inherit;opacity:.75;margin:0 0 16px}' +
    'a.btn,button{display:inline-block;background:#111;color:#fff;border:0;border-radius:8px;padding:11px 22px;font-size:14px;font-weight:600;text-decoration:none;cursor:pointer;font-family:inherit}' +
    'input{width:100%;border:1px solid #e6e6e6;border-radius:8px;padding:11px 12px;font-size:14px;font-family:inherit;outline:none;box-sizing:border-box;margin-bottom:12px}' +
    '</style></head><body><div class="card"><h1>' + title + '</h1>' + bodyHtml + '</div></body></html>';
  // miniPage 沒有任何 script → CSP 直接 script-src 'none'（不用 nonce）
  return new Response(html, {
    status: status || 200,
    headers: Object.assign(
      { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      securityHeaders(null)
    )
  });
}

export { json };
