// Phase D 可觀測性：/api/health、/api/admin/errors、/api/admin/stats、/api/csp-report、
// 以及 relay／playground 的 errlog 埋點有真的寫進去。
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { env, fetchMock } from "cloudflare:test";
import { onRequestGet as healthGet } from "../../functions/api/health.js";
import { onRequestGet as errsGet, onRequestDelete as errsDel } from "../../functions/api/admin/errors.js";
import { onRequestGet as statsGet } from "../../functions/api/admin/stats.js";
import { onRequestPost as cspPost } from "../../functions/api/csp-report.js";
import { onRequest as relayHandler } from "../../functions/relay/[[path]].js";
import { reportErrorNow } from "../../lib/observe.js";
import { logReq } from "../../lib/quota.js";
import { makeCtx, drainWaits, seedUser, giveKey, seedChannel, envWith, ORIGIN } from "../helpers.js";

const TOK = "admintok";
const AUTH = { authorization: "Bearer " + TOK };
const E = () => envWith({ LOGS_TOKEN: TOK });

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

describe("/api/health", () => {
  it("公開回 { ok, version, db:true }", async () => {
    const r = await healthGet(makeCtx({ url: ORIGIN + "/api/health" }));
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.version).toBe("1.0.0");
    expect(j.db).toBe(true);
  });
});

describe("/api/admin/errors", () => {
  it("沒授權 401；分頁列出；DELETE 清空", async () => {
    const anon = makeCtx({ url: ORIGIN + "/api/admin/errors", env: E() });
    expect((await errsGet(anon)).status).toBe(401);

    await reportErrorNow(env, "test.src", new Error("第一筆"), { path: "/x" });
    await reportErrorNow(env, "test.src", "第二筆");
    const ctx = makeCtx({ url: ORIGIN + "/api/admin/errors?limit=1", init: { headers: AUTH }, env: E() });
    const j = await (await errsGet(ctx)).json();
    expect(j.total).toBe(2);
    expect(j.rows.length).toBe(1);
    expect(j.rows[0].msg).toBe("第二筆");        // 新的在前

    const del = makeCtx({ url: ORIGIN + "/api/admin/errors", init: { method: "DELETE", headers: AUTH }, env: E() });
    expect((await errsDel(del)).status).toBe(200);
    const after = await (await errsGet(makeCtx({ url: ORIGIN + "/api/admin/errors", init: { headers: AUTH }, env: E() }))).json();
    expect(after.total).toBe(0);
  });

  it("src 過濾", async () => {
    await reportErrorNow(env, "relay.upstream", "a");
    await reportErrorNow(env, "pg.stream", "b");
    const ctx = makeCtx({ url: ORIGIN + "/api/admin/errors?src=pg.stream", init: { headers: AUTH }, env: E() });
    const j = await (await errsGet(ctx)).json();
    expect(j.total).toBe(1);
    expect(j.rows[0].src).toBe("pg.stream");
  });
});

describe("/api/admin/stats", () => {
  it("彙總每日／渠道×模型＋原始 durs", async () => {
    const u = await seedUser({ status: "approved" });
    await logReq(env, { user_id: u.id, svc: "relay", channel: "c1", model: "m1", status: 200, dur_ms: 100, ttfb_ms: 40, tokens_in: 10, tokens_out: 20 });
    await logReq(env, { user_id: u.id, svc: "relay", channel: "c1", model: "m1", status: 502, dur_ms: 300 });
    await logReq(env, { user_id: u.id, svc: "pg", channel: "c2", model: "m2", status: 200, dur_ms: 200, tokens_in: 5, tokens_out: 6 });
    const ctx = makeCtx({ url: ORIGIN + "/api/admin/stats?days=7", init: { headers: AUTH }, env: E() });
    const j = await (await statsGet(ctx)).json();
    expect(j.days).toBe(7);
    const relayDay = j.by_day.find((r) => r.svc === "relay");
    expect(relayDay.n).toBe(2);
    expect(relayDay.errs).toBe(1);
    expect(relayDay.avg_dur).toBe(200);
    const ch = j.by_channel.find((r) => r.channel === "c1" && r.model === "m1");
    expect(ch.n).toBe(2);
    expect(ch.tokens_in).toBe(10);
    expect(j.durs.length).toBe(3);
  });
  it("days 界限外自動回 7", async () => {
    const ctx = makeCtx({ url: ORIGIN + "/api/admin/stats?days=999", init: { headers: AUTH }, env: E() });
    expect((await (await statsGet(ctx)).json()).days).toBe(7);
  });
});

describe("/api/csp-report", () => {
  it("永遠 204；取樣寫入 errlog（Math.random stub 保證取樣命中）", async () => {
    const orig = Math.random;
    Math.random = () => 0.05;   // < 0.1 → 必取樣
    try {
      const body = JSON.stringify({ "csp-report": { "violated-directive": "script-src", "document-uri": "https://uaip.cc.cd/x", "blocked-uri": "https://evil.com/a.js" } });
      const ctx = makeCtx({ url: ORIGIN + "/api/csp-report", init: { method: "POST", body } });
      const r = await cspPost(ctx);
      expect(r.status).toBe(204);
      const row = await env.DB.prepare("SELECT * FROM errlog WHERE src='csp' ORDER BY id DESC LIMIT 1").first();
      expect(row.msg).toContain("script-src");
      expect(row.msg).toContain("evil.com");
    } finally { Math.random = orig; }
  });
  it("沒被取樣時什麼都不寫、照樣 204", async () => {
    const orig = Math.random;
    Math.random = () => 0.9;
    try {
      const ctx = makeCtx({ url: ORIGIN + "/api/csp-report", init: { method: "POST", body: "junk" } });
      expect((await cspPost(ctx)).status).toBe(204);
      const n = await env.DB.prepare("SELECT COUNT(*) c FROM errlog").first();
      expect(n.c).toBe(0);
    } finally { Math.random = orig; }
  });
});

describe("埋點：relay 上游故障進 errlog", () => {
  it("連不上上游 → errlog src=relay.upstream", async () => {
    const u = await seedUser({ status: "approved", services: "relay" });
    const key = await giveKey(u);
    await seedChannel({ slug: "ob1" });
    fetchMock.get("https://api.example.com").intercept({ path: "/v1/models" }).replyWithError(new Error("boom"));
    const ctx = makeCtx({
      url: ORIGIN + "/relay/ob1/v1/models",
      init: { headers: { authorization: "Bearer " + key } },
      params: { path: ["ob1", "v1", "models"] }
    });
    const r = await relayHandler(ctx);
    expect(r.status).toBe(502);
    await drainWaits(ctx);
    const row = await env.DB.prepare("SELECT * FROM errlog WHERE src='relay.upstream' ORDER BY id DESC LIMIT 1").first();
    expect(row).toBeTruthy();
    expect(row.user_id).toBe(u.id);
    expect(row.path).toBe("/relay/ob1");
  });

  it("上游 5xx（回應照轉）也留一筆", async () => {
    const u = await seedUser({ status: "approved", services: "relay" });
    const key = await giveKey(u);
    await seedChannel({ slug: "ob2" });
    fetchMock.get("https://api.example.com").intercept({ path: "/v1/models" }).reply(503, "down");
    const ctx = makeCtx({
      url: ORIGIN + "/relay/ob2/v1/models",
      init: { headers: { authorization: "Bearer " + key } },
      params: { path: ["ob2", "v1", "models"] }
    });
    const r = await relayHandler(ctx);
    expect(r.status).toBe(503);          // 會員照樣拿到上游原話
    await r.text();
    await drainWaits(ctx);
    const row = await env.DB.prepare("SELECT * FROM errlog WHERE src='relay.upstream' ORDER BY id DESC LIMIT 1").first();
    expect(row.msg).toContain("503");
  });
});
