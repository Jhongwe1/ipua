// Phase E 安全強化：logout-all、revoke_sessions、audit_log 落庫、miniPage CSP。
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { onRequestPost as logoutAll } from "../../functions/api/account/logout-all.js";
import { onRequestPut as usersPut } from "../../functions/api/admin/users/[id].js";
import { onRequestPut as settingsPut } from "../../functions/api/admin/settings.js";
import { createSession, miniPage } from "../../lib/auth.js";
import { makeCtx, drainWaits, seedUser, seedAdmin, envWith, ORIGIN } from "../helpers.js";

const TOK = "admintok";

describe("/api/account/logout-all（會員自助撤銷全部裝置）", () => {
  it("刪光自己的 session、清 cookie；不影響別人", async () => {
    const u = await seedUser({ status: "approved" });
    const other = await seedUser({ status: "approved" });
    const s1 = await createSession(env, u, new URL(ORIGIN + "/"));
    await createSession(env, u, new URL(ORIGIN + "/"));
    await createSession(env, other, new URL(ORIGIN + "/"));

    const ctx = makeCtx({
      url: ORIGIN + "/api/account/logout-all",
      init: { method: "POST", headers: { cookie: "ipua_sess=" + s1.sid, origin: ORIGIN } }
    });
    const r = await logoutAll(ctx);
    expect(r.status).toBe(200);
    expect(r.headers.get("set-cookie")).toContain("ipua_sess=;");   // 本裝置 cookie 清掉
    const mine = await env.DB.prepare("SELECT COUNT(*) c FROM sessions WHERE user_id=?1").bind(u.id).first();
    const theirs = await env.DB.prepare("SELECT COUNT(*) c FROM sessions WHERE user_id=?1").bind(other.id).first();
    expect(mine.c).toBe(0);
    expect(theirs.c).toBe(1);
  });
  it("未登入 401；跨站 Origin 403", async () => {
    const anon = makeCtx({ url: ORIGIN + "/api/account/logout-all", init: { method: "POST" } });
    expect((await logoutAll(anon)).status).toBe(401);
    const u = await seedUser({ status: "approved" });
    const s = await createSession(env, u, new URL(ORIGIN + "/"));
    const evil = makeCtx({
      url: ORIGIN + "/api/account/logout-all",
      init: { method: "POST", headers: { cookie: "ipua_sess=" + s.sid, origin: "https://evil.com" } }
    });
    expect((await logoutAll(evil)).status).toBe(403);
  });
});

describe("站長 revoke_sessions", () => {
  it("目標會員所有裝置立即失效、帳號狀態不動、寫 audit", async () => {
    const u = await seedUser({ status: "approved", services: "relay" });
    await createSession(env, u, new URL(ORIGIN + "/"));
    await createSession(env, u, new URL(ORIGIN + "/"));
    const ctx = makeCtx({
      url: ORIGIN + "/api/admin/users/" + u.id,
      init: {
        method: "PUT",
        headers: { authorization: "Bearer " + TOK, "content-type": "application/json" },
        body: JSON.stringify({ action: "revoke_sessions" })
      },
      params: { id: String(u.id) },
      env: envWith({ LOGS_TOKEN: TOK })
    });
    const r = await usersPut(ctx);
    expect(r.status).toBe(200);
    await drainWaits(ctx);
    const n = await env.DB.prepare("SELECT COUNT(*) c FROM sessions WHERE user_id=?1").bind(u.id).first();
    expect(n.c).toBe(0);
    const row = await env.DB.prepare("SELECT * FROM users WHERE id=?1").bind(u.id).first();
    expect(row.status).toBe("approved");                     // 狀態與服務不動
    const audit = await env.DB.prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT 1").first();
    expect(audit.action).toBe("users.revoke_sessions");
    expect(audit.actor).toBe("token");                       // 金鑰身分記 token
  });
});

describe("audit_log 落庫", () => {
  it("set_services 記清單；settings.put 記改了哪些鍵；cookie 身分記 email", async () => {
    const adm = await seedAdmin();
    const sess = await createSession(env, adm, new URL(ORIGIN + "/"));
    const u = await seedUser();
    const ctx = makeCtx({
      url: ORIGIN + "/api/admin/users/" + u.id,
      init: {
        method: "PUT",
        headers: { cookie: "ipua_sess=" + sess.sid, origin: ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ action: "set_services", services: ["relay"] })
      },
      params: { id: String(u.id) },
      env: envWith({})
    });
    await usersPut(ctx);
    await drainWaits(ctx);
    let row = await env.DB.prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT 1").first();
    expect(row.action).toBe("users.set_services");
    expect(row.actor).toBe(adm.email);                       // cookie 身分＝email
    expect(row.summary).toContain("relay");

    const ctx2 = makeCtx({
      url: ORIGIN + "/api/admin/settings",
      init: {
        method: "PUT",
        headers: { authorization: "Bearer " + TOK, "content-type": "application/json" },
        body: JSON.stringify({ pg_open: true, quota_relay_day: 100 })
      },
      env: envWith({ LOGS_TOKEN: TOK })
    });
    await settingsPut(ctx2);
    await drainWaits(ctx2);
    row = await env.DB.prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT 1").first();
    expect(row.action).toBe("settings.put");
    expect(row.summary).toContain("pg_open=true");
    expect(row.summary).toContain("quota_relay_day=100");
  });
});

describe("miniPage 靜態 CSP", () => {
  it("script-src 'none'（頁面本來就沒 script）", () => {
    const r = miniPage("測試", "<p>hi</p>");
    const csp = r.headers.get("content-security-policy");
    expect(csp).toContain("script-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
  });
});
