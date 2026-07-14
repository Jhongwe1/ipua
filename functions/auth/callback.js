// GET /auth/callback — Google 登入第二步：Google 把使用者帶回來這裡（帶授權碼）。
// 伺服器直連 Google 用授權碼＋CLIENT_SECRET 換 id_token（走 TLS、直接來自 Google，
// 內容可信，不需再驗簽章），核對 aud 與 state 後建立／更新會員並種下登入 cookie。
import {
  getCookie, safeNext, miniPage, createSession, adminEmails, randToken
} from "../../lib/auth.js";
import { reportError } from "../../lib/observe.js";

function b64urlJson(part) {
  try {
    const s = part.replace(/-/g, "+").replace(/_/g, "/");
    const pad = s + "===".slice((s.length + 3) % 4);
    const bin = atob(pad);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (e) { return null; }
}

function fail(text) {
  return miniPage("登入失敗",
    "<p>" + text + "</p><a class=\"btn\" href=\"/auth/login\">再試一次</a> &nbsp; <a class=\"btn\" href=\"/\">回首頁</a>", 400);
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  // 登入流程的失敗要進站內錯誤日誌（會員只會看到 miniPage，站長在 /logs 錯誤分頁看原因）
  const oops = function (err, detail) {
    reportError(env, function (p) { context.waitUntil(p); }, "oauth.callback", err,
      { path: "/auth/callback", detail: detail });
  };
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return fail("Google 登入尚未設定完成。");
  if (!env.DB) return fail("資料庫未連線。");

  if (url.searchParams.get("error")) return fail("你在 Google 頁面取消了登入。");
  const code = url.searchParams.get("code") || "";
  const state = url.searchParams.get("state") || "";

  // state 必須跟出發時存在 cookie 裡的一致（擋跨站偽造的回跳）
  const saved = getCookie(request, "ipua_oauth");
  const sep = saved.indexOf("|");
  if (!code || !state || sep < 0 || saved.slice(0, sep) !== state) {
    return fail("登入狀態不符或已過期（超過 10 分鐘）。");
  }
  const next = safeNext(saved.slice(sep + 1));

  // 授權碼換 token
  let tok = null;
  try {
    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: code,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: url.origin + "/auth/callback",
        grant_type: "authorization_code"
      })
    });
    tok = await r.json();
    if (!r.ok) {
      oops("Google token 交換被拒（HTTP " + r.status + "）", JSON.stringify(tok).slice(0, 500));
      return fail("Google 拒絕了這次登入（" + (tok.error || r.status) + "）。redirect_uri 是否已在 Google Cloud 登記：" + url.origin + "/auth/callback");
    }
  } catch (e) {
    oops(e);
    return fail("連不上 Google 伺服器，請稍後再試。");
  }

  const parts = String(tok.id_token || "").split(".");
  const claims = parts.length === 3 ? b64urlJson(parts[1]) : null;
  if (!claims || !claims.sub || claims.aud !== env.GOOGLE_CLIENT_ID) {
    oops("id_token claims 驗證失敗（缺 sub 或 aud 不符）");
    return fail("身分資料驗證失敗。");
  }
  if (claims.email_verified === false) return fail("這個 Google 帳號的信箱未通過驗證。");

  const email = String(claims.email || "").toLowerCase();
  const isAdm = adminEmails(env).indexOf(email) >= 0;
  const now = new Date().toISOString();

  // 建立或更新會員：新帳號預設 pending（待站長核准）；站長信箱自動核准＋管理員。
  // 既有帳號每次登入同步信箱／名字／頭像；被加進站長清單的舊帳號也在這裡自動升級。
  await env.DB.prepare(
    "INSERT INTO users (google_sub,email,name,picture,status,is_admin,vpn_token,created_at,last_login) " +
    "VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?8) " +
    "ON CONFLICT(google_sub) DO UPDATE SET " +
    "email=?2, name=?3, picture=?4, last_login=?8, " +
    "is_admin=CASE WHEN ?6=1 THEN 1 ELSE is_admin END, " +
    "status=CASE WHEN ?6=1 AND status='pending' THEN 'approved' ELSE status END"
  ).bind(
    claims.sub, email,
    String(claims.name || "").slice(0, 80),
    String(claims.picture || "").slice(0, 300),
    isAdm ? "approved" : "pending", isAdm ? 1 : 0,
    randToken("uvt", 20), now
  ).run();
  const user = await env.DB.prepare("SELECT * FROM users WHERE google_sub=?1").bind(claims.sub).first();
  if (!user) return fail("帳號建立失敗，請再試一次。");

  const sess = await createSession(env, user, url);
  const headers = new Headers({ Location: next });
  sess.cookies.forEach(function (c) { headers.append("Set-Cookie", c); });
  headers.append("Set-Cookie", "ipua_oauth=; Path=/auth; Max-Age=0; HttpOnly; SameSite=Lax" +
    (url.protocol === "https:" ? "; Secure" : ""));
  return new Response(null, { status: 302, headers: headers });
}
