// OAuth 授權碼流程（/auth/callback）全流程 — 用 fetchMock 攔 Google token 端點。
// 這是「任何人能不能變成會員／站長」的信任邊界，遷移前一定要有網。
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { env, fetchMock } from "cloudflare:test";
import { onRequestGet as callback } from "../../functions/auth/callback.js";
import { getSessionUser } from "../../lib/auth.js";
import { makeCtx, drainWaits, envWith, ORIGIN } from "../helpers.js";

const CID = "test-client-id.apps.googleusercontent.com";
const GOOGLE = "https://oauth2.googleapis.com";

beforeAll(() => { fetchMock.activate(); fetchMock.disableNetConnect(); });
afterEach(() => fetchMock.assertNoPendingInterceptors());

// 造一顆假 id_token（header.payload.signature）— 伺服器只 base64url 解 payload、核對 aud，不驗簽章。
// Google 的 payload 是 UTF-8 JSON 的 base64url，所以中文名要先編成 UTF-8 位元組再 btoa。
function idToken(claims) {
  const b64 = (o) => {
    const bytes = new TextEncoder().encode(JSON.stringify(o));
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };
  return b64({ alg: "RS256" }) + "." + b64(claims) + ".sig";
}
function mockToken(idTok, status) {
  fetchMock.get(GOOGLE).intercept({ path: "/token", method: "POST" })
    .reply(status || 200, JSON.stringify({ id_token: idTok }), { headers: { "content-type": "application/json" } });
}
// state|next 存在 ipua_oauth cookie；callback 讀 ?code & ?state 與它核對
function cbCtx(code, state, cookieVal, over) {
  return makeCtx({
    url: ORIGIN + "/auth/callback?code=" + code + "&state=" + state,
    init: { headers: { cookie: "ipua_oauth=" + encodeURIComponent(cookieVal) } },
    env: envWith(Object.assign({ GOOGLE_CLIENT_ID: CID, GOOGLE_CLIENT_SECRET: "secret" }, over || {}))
  });
}

describe("OAuth callback 全流程", () => {
  it("新帳號：state 對＋token 換成功 → 建 pending 會員、種 session、302 跳 next", async () => {
    const sub = "g-" + Math.random().toString(36).slice(2);
    mockToken(idToken({ sub, aud: CID, email: "New@Example.com", email_verified: true, name: "新人", picture: "https://x/y.png" }));
    const ctx = cbCtx("authcode", "st1", "st1|/vpn");
    const r = await callback(ctx);
    await drainWaits(ctx);
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/vpn");
    const setCookies = r.headers.getSetCookie().join("\n");
    expect(setCookies).toContain("ipua_sess=");
    expect(setCookies).toContain("ipua_oauth=;");                 // 用過即清掉
    const row = await env.DB.prepare("SELECT * FROM users WHERE google_sub=?1").bind(sub).first();
    expect(row.email).toBe("new@example.com");                    // 信箱小寫化
    expect(row.status).toBe("pending");                           // 一般人預設待批准
    expect(row.is_admin).toBe(0);
    expect(row.vpn_token).toMatch(/^uvt[a-z2-7]{20}$/);
  });

  it("站長信箱：自動 approved＋is_admin=1", async () => {
    const sub = "g-adm-" + Math.random().toString(36).slice(2);
    mockToken(idToken({ sub, aud: CID, email: "admin@example.com", email_verified: true, name: "站長" }));
    const ctx = cbCtx("c", "s", "s|/", { ADMIN_EMAILS: "admin@example.com" });
    const r = await callback(ctx);
    await drainWaits(ctx);
    expect(r.status).toBe(302);
    const row = await env.DB.prepare("SELECT * FROM users WHERE google_sub=?1").bind(sub).first();
    expect(row.status).toBe("approved");
    expect(row.is_admin).toBe(1);
  });

  it("既有帳號再登入：更新名字/頭像、不覆蓋 status；session 可取回", async () => {
    const sub = "g-old-" + Math.random().toString(36).slice(2);
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO users (google_sub,email,name,picture,status,is_admin,vpn_token,created_at,last_login) " +
      "VALUES (?1,?2,'舊名','',?3,0,'uvtoldtoken1234567890',?4,?4)"
    ).bind(sub, "old@example.com", "approved", now).run();
    mockToken(idToken({ sub, aud: CID, email: "old@example.com", email_verified: true, name: "新名", picture: "https://x/p.png" }));
    const ctx = cbCtx("c", "s", "s|/news");
    const r = await callback(ctx);
    await drainWaits(ctx);
    expect(r.headers.get("location")).toBe("/news");
    const row = await env.DB.prepare("SELECT * FROM users WHERE google_sub=?1").bind(sub).first();
    expect(row.name).toBe("新名");
    expect(row.status).toBe("approved");                          // 不被登入洗回 pending
    // 種下的 cookie 真的能換回這個 user
    const sid = r.headers.getSetCookie().join("\n").match(/ipua_sess=([^;]+)/)[1];
    const back = await getSessionUser(new Request(ORIGIN + "/", { headers: { cookie: "ipua_sess=" + sid } }), env);
    expect(back.google_sub).toBe(sub);
  });

  it("state 不符 → 400，不打 Google（無 pending interceptor）", async () => {
    const r = await callback(cbCtx("c", "wrong", "right|/"));
    expect(r.status).toBe(400);
    expect(await r.text()).toContain("登入狀態不符");
  });

  it("aud 不是自己的 client id → 400 身分驗證失敗", async () => {
    mockToken(idToken({ sub: "x", aud: "someone-else", email: "a@b.c", email_verified: true }));
    const ctx = cbCtx("c", "s", "s|/");
    const r = await callback(ctx);
    await drainWaits(ctx);
    expect(r.status).toBe(400);
    expect(await r.text()).toContain("身分資料驗證失敗");
  });

  it("email_verified=false → 400 擋下", async () => {
    mockToken(idToken({ sub: "x2", aud: CID, email: "a@b.c", email_verified: false }));
    const ctx = cbCtx("c", "s", "s|/");
    const r = await callback(ctx);
    await drainWaits(ctx);
    expect(r.status).toBe(400);
    expect(await r.text()).toContain("未通過驗證");
  });

  it("Google 拒絕 token 交換（HTTP 400）→ 400 並提示 redirect_uri", async () => {
    fetchMock.get(GOOGLE).intercept({ path: "/token", method: "POST" })
      .reply(400, JSON.stringify({ error: "invalid_grant" }), { headers: { "content-type": "application/json" } });
    const ctx = cbCtx("badcode", "s", "s|/");
    const r = await callback(ctx);
    await drainWaits(ctx);
    expect(r.status).toBe(400);
    expect(await r.text()).toContain("invalid_grant");
  });

  it("未設定 Google 憑證 → 400 尚未設定完成", async () => {
    const ctx = makeCtx({
      url: ORIGIN + "/auth/callback?code=c&state=s",
      init: { headers: { cookie: "ipua_oauth=s|/" } },
      env: envWith({ GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "" })
    });
    const r = await callback(ctx);
    expect(r.status).toBe(400);
    expect(await r.text()).toContain("尚未設定完成");
  });
});
