// relay 計量與配額（Phase C）：429、req_log、usage 掃描、直通開關、斷線停抓。
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { env, fetchMock } from "cloudflare:test";
import { onRequest } from "../../functions/relay/[[path]].js";
import { logReq } from "../../lib/quota.js";
import { makeCtx, drainWaits, seedUser, seedAdmin, giveKey, seedChannel, ORIGIN } from "../helpers.js";

const UP = "https://api.example.com";

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

function ctxFor(key, path, init) {
  const segs = path.split("/").filter(Boolean).slice(1);   // 去掉 "relay"
  return makeCtx({
    url: ORIGIN + path,
    init: Object.assign({ headers: { authorization: "Bearer " + key } }, init || {}),
    params: { path: segs }
  });
}

const lastLog = () => env.DB.prepare("SELECT * FROM req_log ORDER BY id DESC LIMIT 1").first();

describe("relay 配額", () => {
  it("超過個人日配額 → 429 quota-exceeded＋Retry-After；上游一次都不會被打", async () => {
    const u = await seedUser({ status: "approved", services: "relay", quota_relay_day: 1, rl_per_min: 99 });
    const key = await giveKey(u);
    await seedChannel({ slug: "m1" });
    await logReq(env, { user_id: u.id, svc: "relay", status: 200 });   // 今天已用 1 次
    const ctx = ctxFor(key, "/relay/m1/v1/models");
    const r = await onRequest(ctx);
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toMatch(/^\d+$/);
    expect((await r.json()).error).toBe("quota-exceeded");
  });

  it("站長帶自己的金鑰不吃配額（quota_relay_day=0 也照轉）", async () => {
    const adm = await seedAdmin({ quota_relay_day: 0, rl_per_min: 0 });
    const key = await giveKey(adm);
    await seedChannel({ slug: "m2" });
    fetchMock.get(UP).intercept({ path: "/v1/models" }).reply(200, "{}");
    const ctx = ctxFor(key, "/relay/m2/v1/models");
    const r = await onRequest(ctx);
    await r.text();
    await drainWaits(ctx);
    expect(r.status).toBe(200);
  });
});

describe("relay 計量 pump", () => {
  async function member(chOver) {
    const u = await seedUser({ status: "approved", services: "relay" });
    const key = await giveKey(u);
    const ch = await seedChannel(Object.assign({ slug: "mm" }, chOver || {}));
    return { u, key, ch };
  }

  it("SSE 串流：位元組保真＋req_log 記到 model/tokens/ttfb/dur", async () => {
    const { u, key } = await member();
    const sse =
      'data: {"model":"gpt-z","choices":[{"delta":{"content":"你好"}}]}\n\n' +
      'data: {"model":"gpt-z","choices":[],"usage":{"prompt_tokens":7,"completion_tokens":19}}\n\n' +
      "data: [DONE]\n\n";
    fetchMock.get(UP).intercept({ path: "/v1/chat/completions", method: "POST" })
      .reply(200, sse, { headers: { "content-type": "text/event-stream" } });
    const ctx = ctxFor(key, "/relay/mm/v1/chat/completions", { method: "POST", body: "{}" });
    const r = await onRequest(ctx);
    expect(await r.text()).toBe(sse);          // pump 不改一個位元組
    await drainWaits(ctx);
    const log = await lastLog();
    expect(log.user_id).toBe(u.id);
    expect(log.svc).toBe("relay");
    expect(log.channel).toBe("mm");
    expect(log.model).toBe("gpt-z");
    expect(log.status).toBe(200);
    expect(log.tokens_in).toBe(7);
    expect(log.tokens_out).toBe(19);
    expect(log.ttfb_ms).toBeGreaterThanOrEqual(0);
    expect(log.dur_ms).toBeGreaterThanOrEqual(log.ttfb_ms);
    // 舊計數器也照加
    const row = await env.DB.prepare("SELECT relay_calls FROM users WHERE id=?1").bind(u.id).first();
    expect(row.relay_calls).toBe(1);
  });

  it("整包 JSON 回應也掃得到 usage", async () => {
    const { key } = await member({ slug: "mj" });
    fetchMock.get(UP).intercept({ path: "/v1/chat/completions", method: "POST" })
      .reply(200, '{"model":"m-json","usage":{"prompt_tokens":2,"completion_tokens":3},"choices":[]}',
        { headers: { "content-type": "application/json" } });
    const ctx = ctxFor(key, "/relay/mj/v1/chat/completions", { method: "POST", body: "{}" });
    await (await onRequest(ctx)).text();
    await drainWaits(ctx);
    const log = await lastLog();
    expect(log.model).toBe("m-json");
    expect(log.tokens_in).toBe(2);
    expect(log.tokens_out).toBe(3);
  });

  it("relay_meter='0' → 純直通、不寫 req_log（免部署保險開關）", async () => {
    const { key } = await member({ slug: "mo" });
    await env.DB.prepare("INSERT INTO settings (k,v) VALUES ('relay_meter','0')").run();
    fetchMock.get(UP).intercept({ path: "/v1/models" }).reply(200, "{}");
    const ctx = ctxFor(key, "/relay/mo/v1/models");
    const r = await onRequest(ctx);
    expect(await r.text()).toBe("{}");
    await drainWaits(ctx);
    const n = await env.DB.prepare("SELECT COUNT(*) c FROM req_log").first();
    expect(n.c).toBe(0);
  });

  it("連不上上游 → 502＋req_log status:0", async () => {
    const { u, key } = await member({ slug: "mx" });
    fetchMock.get(UP).intercept({ path: "/v1/models" }).replyWithError(new Error("ECONNREFUSED"));
    const ctx = ctxFor(key, "/relay/mx/v1/models");
    const r = await onRequest(ctx);
    expect(r.status).toBe(502);
    await drainWaits(ctx);
    const log = await lastLog();
    expect(log.status).toBe(0);
    expect(log.user_id).toBe(u.id);
  });

  it("客戶端中斷（取消回應串流）→ 上游被 cancel、req_log 照寫", async () => {
    const { key } = await member({ slug: "mc" });
    fetchMock.get(UP).intercept({ path: "/v1/chat/completions", method: "POST" })
      .reply(200, 'data: {"model":"m-abort"}\n\n', { headers: { "content-type": "text/event-stream" } });
    const ctx = ctxFor(key, "/relay/mc/v1/chat/completions", { method: "POST", body: "{}" });
    const r = await onRequest(ctx);
    await r.body.cancel();          // 模擬會員關掉連線
    await drainWaits(ctx);          // pump 應正常收尾（cancel 上游、寫 log），不會卡住
    const log = await lastLog();
    expect(log.svc).toBe("relay");
    expect(log.channel).toBe("mc");
  });
});
