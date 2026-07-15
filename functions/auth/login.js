// GET /auth/login — 把訪客導去 Google 登入頁（OAuth 授權碼流程第一步）。
// ?next=/vpn 這種站內路徑會在登入完成後跳回去。
// 沒設定 GOOGLE_CLIENT_ID 時：正式站顯示「尚未開通」；本機（localhost）改提供
// 「測試登入」表單（POST 到本頁），方便沒有 Google 憑證也能開發測試。
import { isLocal, safeNext, randToken, miniPage, createSession, adminEmails } from "../../lib/auth.js";

const OAUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const next = safeNext(url.searchParams.get("next"));

  if (!env.GOOGLE_CLIENT_ID) {
    if (isLocal(url)) return devForm(next);
    return miniPage("Google 登入尚未開通",
      '<p>站長還沒設定 Google 登入憑證（GOOGLE_CLIENT_ID／GOOGLE_CLIENT_SECRET）。設定方式見專案 ADMIN.md。</p>' +
      '<a class="btn" href="/">回首頁</a>', 503);
  }

  const state = randToken("", 26);
  const p = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: url.origin + "/auth/callback",
    response_type: "code",
    scope: "openid email profile",
    state: state,
    prompt: "select_account"
  });
  const headers = new Headers({ Location: OAUTH_URL + "?" + p.toString() });
  // state（防偽 CSRF）與 next（跳回位置）放進 10 分鐘的暫時 cookie，callback 時核對
  headers.append("Set-Cookie",
    "ipua_oauth=" + encodeURIComponent(state + "|" + next) +
    "; Path=/auth; Max-Age=600; HttpOnly; SameSite=Lax" +
    (url.protocol === "https:" ? "; Secure" : ""));
  return new Response(null, { status: 302, headers: headers });
}

// 本機測試登入：輸入任意信箱就建立帳號＋登入（只在 localhost 生效；正式站走不到這裡）
export async function onRequestPost({ request, env }) {
  const url = new URL(request.url);
  if (!isLocal(url)) return miniPage("不支援", "<p>此登入方式僅供本機開發。</p>", 403);
  if (!env.DB) return miniPage("錯誤", "<p>本機資料庫未建立 — 先跑 npm run migrate:local。</p>", 500);

  const form = await request.formData().catch(function () { return null; });
  const email = String(form && form.get("email") || "").trim().toLowerCase();
  const next = safeNext(form && form.get("next"));
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return devForm(next, "信箱格式不對，再試一次。");

  const now = new Date().toISOString();
  const sub = "dev:" + email;
  const isAdm = adminEmails(env).indexOf(email) >= 0 ? 1 : 0;
  await env.DB.prepare(
    "INSERT INTO users (google_sub,email,name,picture,status,is_admin,vpn_token,created_at,last_login) " +
    "VALUES (?1,?2,?3,'',?4,?5,?6,?7,?7) " +
    "ON CONFLICT(google_sub) DO UPDATE SET last_login=?7"
  ).bind(sub, email, email.split("@")[0], isAdm ? "approved" : "pending", isAdm,
         randToken("uvt", 20), now).run();
  const user = await env.DB.prepare("SELECT * FROM users WHERE google_sub=?1").bind(sub).first();

  const sess = await createSession(env, user, url);
  const headers = new Headers({ Location: next });
  sess.cookies.forEach(function (c) { headers.append("Set-Cookie", c); });
  return new Response(null, { status: 302, headers: headers });
}

function devForm(next, err) {
  return miniPage("本機測試登入",
    '<p>本機開發模式（正式站是真正的 Google 登入）。輸入信箱就能以該身分登入；' +
    '輸入站長信箱＝站長身分。</p>' +
    (err ? '<p>⚠ ' + err + '</p>' : '') +
    '<form method="POST" action="/auth/login">' +
    '<input type="hidden" name="next" value="' + String(next).replace(/"/g, "&quot;") + '">' +
    '<input name="email" type="email" placeholder="test@example.com" autofocus>' +
    '<button type="submit">登入</button></form>');
}
