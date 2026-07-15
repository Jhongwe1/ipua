// 會員自助端點：API 金鑰、VPN 訂閱代碼、登出所有裝置。
// 重點：要登入、要過 Origin（CSRF）、金鑰明文只出現一次且庫內只存雜湊。
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { onRequestPost as keyPost, onRequestDelete as keyDelete } from "../../functions/api/account/key.js";
import { onRequestPost as vpnPost } from "../../functions/api/account/vpn-token.js";
import { onRequestPost as logoutAll } from "../../functions/api/account/logout-all.js";
import { createSession, getSessionUser, sha256hex, userFromKey } from "../../lib/auth.js";
import { makeCtx, seedUser, ORIGIN } from "../helpers.js";

// 帶登入 cookie＋同源 Origin 的 POST/DELETE
async function authed(user, path, method) {
  const s = await createSession(env, user, new URL(ORIGIN + "/"));
  return makeCtx({
    url: ORIGIN + path,
    init: { method, headers: { cookie: "ipua_sess=" + s.sid, origin: ORIGIN } }
  });
}
// 帶登入但 Origin 是外站（模擬 CSRF）
async function crossOrigin(user, path, method) {
  const s = await createSession(env, user, new URL(ORIGIN + "/"));
  return makeCtx({
    url: ORIGIN + path,
    init: { method, headers: { cookie: "ipua_sess=" + s.sid, origin: "https://evil.com" } }
  });
}

describe("/api/account/key", () => {
  it("POST 產生金鑰：明文回一次、庫內存雜湊、可用它換回會員", async () => {
    const u = await seedUser({ status: "approved" });
    const r = await keyPost(await authed(u, "/api/account/key", "POST"));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.key).toMatch(/^uak-[a-z2-7]{26}$/);
    const row = await env.DB.prepare("SELECT api_key_hash FROM users WHERE id=?1").bind(u.id).first();
    expect(row.api_key_hash).toBe(await sha256hex(j.key));      // 庫內只有雜湊
    expect((await userFromKey(env, j.key)).id).toBe(u.id);      // 明文能換回本人
  });

  it("POST 再產生：舊金鑰立即失效", async () => {
    const u = await seedUser({ status: "approved" });
    const k1 = (await (await keyPost(await authed(u, "/api/account/key", "POST"))).json()).key;
    const k2 = (await (await keyPost(await authed(u, "/api/account/key", "POST"))).json()).key;
    expect(k2).not.toBe(k1);
    expect(await userFromKey(env, k1)).toBeNull();              // 舊的死了
    expect((await userFromKey(env, k2)).id).toBe(u.id);
  });

  it("DELETE 撤銷：金鑰欄清空", async () => {
    const u = await seedUser({ status: "approved" });
    const k = (await (await keyPost(await authed(u, "/api/account/key", "POST"))).json()).key;
    const r = await keyDelete(await authed(u, "/api/account/key", "DELETE"));
    expect(r.status).toBe(200);
    expect(await userFromKey(env, k)).toBeNull();
  });

  it("待核准帳號也能先產生金鑰（中轉端點才擋）", async () => {
    const u = await seedUser({ status: "pending" });
    expect((await keyPost(await authed(u, "/api/account/key", "POST"))).status).toBe(200);
  });

  it("封鎖帳號：403", async () => {
    const u = await seedUser({ status: "blocked" });
    expect((await keyPost(await authed(u, "/api/account/key", "POST"))).status).toBe(403);
  });

  it("未登入 → 401；跨站 Origin → 403", async () => {
    expect((await keyPost(makeCtx({ url: ORIGIN + "/api/account/key", init: { method: "POST", headers: { origin: ORIGIN } } }))).status).toBe(401);
    const u = await seedUser({ status: "approved" });
    expect((await keyPost(await crossOrigin(u, "/api/account/key", "POST"))).status).toBe(403);
  });
});

describe("/api/account/vpn-token", () => {
  it("POST 重生：換新 token、舊的立即失效", async () => {
    const u = await seedUser({ status: "approved", vpn_token: "uvt" + "a".repeat(20) });
    const r = await vpnPost(await authed(u, "/api/account/vpn-token", "POST"));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.vpn_token).toMatch(/^uvt[a-z2-7]{20}$/);
    expect(j.vpn_token).not.toBe("uvt" + "a".repeat(20));
    const row = await env.DB.prepare("SELECT vpn_token FROM users WHERE id=?1").bind(u.id).first();
    expect(row.vpn_token).toBe(j.vpn_token);
  });

  it("封鎖 → 403；未登入 → 401；跨站 → 403", async () => {
    const blk = await seedUser({ status: "blocked" });
    expect((await vpnPost(await authed(blk, "/api/account/vpn-token", "POST"))).status).toBe(403);
    expect((await vpnPost(makeCtx({ url: ORIGIN + "/api/account/vpn-token", init: { method: "POST", headers: { origin: ORIGIN } } }))).status).toBe(401);
    const u = await seedUser({ status: "approved" });
    expect((await vpnPost(await crossOrigin(u, "/api/account/vpn-token", "POST"))).status).toBe(403);
  });
});

describe("/api/account/logout-all", () => {
  it("刪光自己所有 session、清 cookie", async () => {
    const u = await seedUser({ status: "approved" });
    const s1 = await createSession(env, u, new URL(ORIGIN + "/"));
    const s2 = await createSession(env, u, new URL(ORIGIN + "/"));
    const r = await logoutAll(makeCtx({
      url: ORIGIN + "/api/account/logout-all",
      init: { method: "POST", headers: { cookie: "ipua_sess=" + s1.sid, origin: ORIGIN } }
    }));
    expect(r.status).toBe(200);
    expect(r.headers.getSetCookie().join("\n")).toContain("ipua_sess=;");   // 清 cookie
    expect(await getSessionUser(new Request(ORIGIN + "/", { headers: { cookie: "ipua_sess=" + s1.sid } }), env)).toBeNull();
    expect(await getSessionUser(new Request(ORIGIN + "/", { headers: { cookie: "ipua_sess=" + s2.sid } }), env)).toBeNull();
  });

  it("未登入 → 401；跨站 → 403", async () => {
    expect((await logoutAll(makeCtx({ url: ORIGIN + "/api/account/logout-all", init: { method: "POST", headers: { origin: ORIGIN } } }))).status).toBe(401);
    const u = await seedUser({ status: "approved" });
    expect((await logoutAll(await crossOrigin(u, "/api/account/logout-all", "POST"))).status).toBe(403);
  });
});
