// GET /api/me — 匿名 {user:null}、會員欄位、金鑰明文絕不出現。
// Phase F 會加「無 vpn 權限者省略 vpn 欄位」矩陣；Phase C 會加 usage 區塊。
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { onRequestGet } from "../../functions/api/me.js";
import { createSession } from "../../lib/auth.js";
import { logReq } from "../../lib/quota.js";
import { makeCtx, seedUser, seedAdmin, giveKey, ORIGIN } from "../helpers.js";

async function meCtx(user) {
  const headers = {};
  if (user) {
    const sess = await createSession(env, user, new URL(ORIGIN + "/"));
    headers.cookie = "ipua_sess=" + sess.sid;
  }
  return makeCtx({ url: ORIGIN + "/api/me", init: { headers } });
}

describe("/api/me", () => {
  it("匿名 → { user: null }", async () => {
    const j = await (await onRequestGet(await meCtx(null))).json();
    expect(j).toEqual({ user: null });
  });

  it("已批准會員：身分欄位齊全、金鑰只給提示不給明文", async () => {
    const u = await seedUser({ status: "approved", services: "relay,playground", vpn_token: "uvt" + "c".repeat(20) });
    const key = await giveKey(u);
    const j = await (await onRequestGet(await meCtx(u))).json();
    expect(j.user.email).toBe(u.email);
    expect(j.user.is_admin).toBe(false);
    expect(j.user.approved).toBe(true);
    expect(j.user.services).toEqual(["relay", "playground"]);
    expect(j.user.has_key).toBe(true);
    expect(j.user.key_hint).toContain("…");
    expect(JSON.stringify(j)).not.toContain(key);        // 金鑰明文絕不回傳
  });

  it("pending 會員：approved=false、services 空", async () => {
    const u = await seedUser({ status: "pending" });
    const j = await (await onRequestGet(await meCtx(u))).json();
    expect(j.user.approved).toBe(false);
    expect(j.user.services).toEqual([]);
  });

  it("站長：is_admin=true、全服務", async () => {
    const a = await seedAdmin();
    const j = await (await onRequestGet(await meCtx(a))).json();
    expect(j.user.is_admin).toBe(true);
    expect(j.user.services).toEqual(["relay", "vpn", "playground"]);
  });

  it("pg_open 全站開放：沒被逐人批准的會員 services 也含 playground", async () => {
    await env.DB.prepare("INSERT INTO settings (k,v) VALUES ('pg_open','1')").run();
    const u = await seedUser({ status: "approved", services: "" });
    const j = await (await onRequestGet(await meCtx(u))).json();
    expect(j.user.services).toContain("playground");
  });

  it("usage 區塊：只含有權限的服務；今日計數正確；個人覆寫反映在 limit", async () => {
    const u = await seedUser({ status: "approved", services: "relay", quota_relay_day: 9 });
    await logReq(env, { user_id: u.id, svc: "relay", status: 200 });
    await logReq(env, { user_id: u.id, svc: "relay", status: 200 });
    const j = await (await onRequestGet(await meCtx(u))).json();
    expect(j.user.usage).toEqual({ relay_today: 2, relay_limit: 9 });   // 沒 pg 權限 → pg 鍵省略
  });

  it("usage：站長 limit=null（無上限）；兩服務都沒權限 → 整塊省略", async () => {
    const a = await seedAdmin();
    const ja = await (await onRequestGet(await meCtx(a))).json();
    expect(ja.user.usage.relay_limit).toBeNull();
    expect(ja.user.usage.pg_limit).toBeNull();
    const p = await seedUser({ status: "pending" });
    const jp = await (await onRequestGet(await meCtx(p))).json();
    expect(jp.user.usage).toBeUndefined();
  });
});
