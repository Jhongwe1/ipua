// /api/admin/users/<id> — 分服務批准語意、狀態耦合、自我保護與 root 站長護欄。
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { onRequestPut, onRequestDelete } from "../../functions/api/admin/users/[id].js";
import { createSession } from "../../lib/auth.js";
import { makeCtx, seedUser, seedAdmin, envWith, ORIGIN } from "../helpers.js";

const TOK = "admintok";
const E = () => envWith({ LOGS_TOKEN: TOK });

function putCtx(id, body, extra) {
  return makeCtx({
    url: ORIGIN + "/api/admin/users/" + id,
    init: {
      method: "PUT",
      headers: Object.assign({ authorization: "Bearer " + TOK, "content-type": "application/json" }, (extra || {}).headers),
      body: JSON.stringify(body)
    },
    params: { id: String(id) },
    env: (extra || {}).env || E()
  });
}
const getUser = (id) => env.DB.prepare("SELECT * FROM users WHERE id=?1").bind(id).first();

describe("set_services（分服務批准）", () => {
  it("白名單過濾：亂七八糟的服務名被丟掉", async () => {
    const u = await seedUser({ status: "approved", services: "relay" });
    const r = await onRequestPut(putCtx(u.id, { action: "set_services", services: ["relay", "bogus", "vpn"] }));
    expect(r.status).toBe(200);
    expect((await getUser(u.id)).services).toBe("relay,vpn");
  });
  it("pending＋給服務 → 自動 approved；全收回 → 退 pending", async () => {
    const u = await seedUser({ status: "pending" });
    await onRequestPut(putCtx(u.id, { action: "set_services", services: ["playground"] }));
    let row = await getUser(u.id);
    expect(row.status).toBe("approved");
    expect(row.services).toBe("playground");
    await onRequestPut(putCtx(u.id, { action: "set_services", services: [] }));
    row = await getUser(u.id);
    expect(row.status).toBe("pending");
    expect(row.services).toBe("");
  });
  it("封鎖中的帳號：改清單但狀態不動", async () => {
    const u = await seedUser({ status: "blocked", services: "" });
    await onRequestPut(putCtx(u.id, { action: "set_services", services: ["relay"] }));
    const row = await getUser(u.id);
    expect(row.status).toBe("blocked");
    expect(row.services).toBe("relay");
  });
  it("services 不是陣列 → 400", async () => {
    const u = await seedUser();
    expect((await onRequestPut(putCtx(u.id, { action: "set_services" }))).status).toBe(400);
  });
});

describe("快速動作", () => {
  it("approve＝一次批准全部服務", async () => {
    const u = await seedUser({ status: "pending" });
    await onRequestPut(putCtx(u.id, { action: "approve" }));
    const row = await getUser(u.id);
    expect(row.status).toBe("approved");
    expect(row.services).toBe("relay,vpn,playground");
  });
  it("block＝封鎖＋踢下線（session 全刪）", async () => {
    const u = await seedUser({ status: "approved" });
    await createSession(env, u, new URL(ORIGIN + "/"));
    await onRequestPut(putCtx(u.id, { action: "block" }));
    expect((await getUser(u.id)).status).toBe("blocked");
    const s = await env.DB.prepare("SELECT COUNT(*) c FROM sessions WHERE user_id=?1").bind(u.id).first();
    expect(s.c).toBe(0);
  });
  it("unblock：原本有服務 → approved；沒服務 → pending", async () => {
    const withSvc = await seedUser({ status: "blocked", services: "relay" });
    await onRequestPut(putCtx(withSvc.id, { action: "unblock" }));
    expect((await getUser(withSvc.id)).status).toBe("approved");
    const noSvc = await seedUser({ status: "blocked", services: "" });
    await onRequestPut(putCtx(noSvc.id, { action: "unblock" }));
    expect((await getUser(noSvc.id)).status).toBe("pending");
  });
  it("不明 action → 400；不存在的 id → 404", async () => {
    const u = await seedUser();
    expect((await onRequestPut(putCtx(u.id, { action: "explode" }))).status).toBe(400);
    expect((await onRequestPut(putCtx(999999, { action: "approve" }))).status).toBe(404);
  });
  it("沒授權 → 401", async () => {
    const u = await seedUser();
    const ctx = makeCtx({
      url: ORIGIN + "/api/admin/users/" + u.id,
      init: { method: "PUT", body: "{}", headers: { "content-type": "application/json" } },
      params: { id: String(u.id) },
      env: E()
    });
    expect((await onRequestPut(ctx)).status).toBe(401);
  });
});

describe("set_quota（個人配額覆寫）", () => {
  it("帶哪鍵改哪鍵；null＝清掉覆寫", async () => {
    const u = await seedUser({ status: "approved", services: "relay" });
    let r = await onRequestPut(putCtx(u.id, { action: "set_quota", quota_relay_day: 5, rl_per_min: 2 }));
    expect(r.status).toBe(200);
    let row = await getUser(u.id);
    expect(row.quota_relay_day).toBe(5);
    expect(row.rl_per_min).toBe(2);
    expect(row.quota_pg_day).toBeNull();          // 沒帶的鍵不動
    r = await onRequestPut(putCtx(u.id, { action: "set_quota", quota_relay_day: null }));
    expect(r.status).toBe(200);
    row = await getUser(u.id);
    expect(row.quota_relay_day).toBeNull();       // 清掉覆寫
    expect(row.rl_per_min).toBe(2);               // 其他鍵不動
  });
  it("0 是合法值（＝直接關掉該服務）；負數／小數／亂字串 → 400；一鍵都沒帶 → 400", async () => {
    const u = await seedUser();
    expect((await onRequestPut(putCtx(u.id, { action: "set_quota", quota_pg_day: 0 }))).status).toBe(200);
    expect((await getUser(u.id)).quota_pg_day).toBe(0);
    for (const bad of [-1, 1.5, "abc"]) {
      expect((await onRequestPut(putCtx(u.id, { action: "set_quota", quota_pg_day: bad }))).status).toBe(400);
    }
    expect((await onRequestPut(putCtx(u.id, { action: "set_quota" }))).status).toBe(400);
  });
});

describe("護欄", () => {
  it("root 站長（ADMIN_EMAILS 內建信箱）不能被封鎖／降級／刪除", async () => {
    const root = await seedAdmin();   // zwwe1f@gmail.com＝內建站長信箱
    for (const action of ["block", "drop_admin"]) {
      const r = await onRequestPut(putCtx(root.id, { action }));
      expect(r.status).toBe(403);
      expect((await r.json()).error).toBe("protected");
    }
    const del = await onRequestDelete(putCtx(root.id, {}));
    expect(del.status).toBe(403);
  });

  it("站長用 cookie 身分時不能封鎖／刪除自己", async () => {
    const admin = await seedUser({ email: "second-admin@example.com", status: "approved", is_admin: 1 });
    const sess = await createSession(env, admin, new URL(ORIGIN + "/"));
    const selfCtx = (method) => makeCtx({
      url: ORIGIN + "/api/admin/users/" + admin.id,
      init: {
        method,
        headers: { cookie: "ipua_sess=" + sess.sid, origin: ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ action: "block" })
      },
      params: { id: String(admin.id) },
      env: envWith({})   // 無 LOGS_TOKEN → 走 cookie 身分
    });
    const r = await onRequestPut(selfCtx("PUT"));
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe("self");
    expect((await onRequestDelete(selfCtx("DELETE"))).status).toBe(400);
  });

  it("刪除一般會員：連 session 一起清", async () => {
    const u = await seedUser({ status: "approved" });
    await createSession(env, u, new URL(ORIGIN + "/"));
    const r = await onRequestDelete(putCtx(u.id, {}));
    expect(r.status).toBe(200);
    expect(await getUser(u.id)).toBeNull();
    const s = await env.DB.prepare("SELECT COUNT(*) c FROM sessions WHERE user_id=?1").bind(u.id).first();
    expect(s.c).toBe(0);
  });
});
