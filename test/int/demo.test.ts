// Demo 體驗模式（v2.0.0 Phase K，ADR-0009）測試矩陣：
// 關→401；開→匿名可聊（對話落在 demo:public 名下、訪客讀不到、max_tokens 預設不壓、填了才壓）；
// 渠道／模型鎖定；4k 輸入上限；IP 日額 429；全站日額 429；DO 壞→503（fail-closed）。
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { env, fetchMock } from "cloudflare:test";
import { onRequestPost as chatPost } from "../../src/routes/api/playground/chat.js";
import { onRequestGet as modelsGet } from "../../src/routes/api/playground/models.js";
import { onRequestGet as settingsGet } from "../../src/routes/api/settings.js";
import { onRequestGet as convListGet } from "../../src/routes/api/playground/conversations/index.js";
import { onRequestGet as convGet } from "../../src/routes/api/playground/conversations/[id].js";
import { onRequestDelete as convDel } from "../../src/routes/api/playground/conversations/[id].js";
import { makeCtx, drainWaits, seedChannel, readAll, sseEvents, envWith, ORIGIN } from "../helpers.js";

const UP = "https://api.example.com";

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

const setS = (k: string, v: string) =>
  env.DB.prepare("INSERT INTO settings (k,v) VALUES (?1,?2) ON CONFLICT(k) DO UPDATE SET v=excluded.v")
    .bind(k, v)
    .run();

async function demoOn(channel: string, extra?: Record<string, string>): Promise<void> {
  await setS("demo_mode", "1");
  await setS("demo_channel", channel);
  for (const k in extra || {}) await setS(k, (extra as Record<string, string>)[k]);
}

// 匿名 ctx（無 cookie 無 Authorization；帶 Origin 過 CSRF 檢查；ip 可指定）
function anonChat(body: unknown, ip?: string) {
  return makeCtx({
    url: ORIGIN + "/api/playground/chat",
    init: {
      method: "POST",
      headers: {
        origin: ORIGIN,
        "content-type": "application/json",
        "cf-connecting-ip": ip || "203.0.113.9"
      },
      body: JSON.stringify(body)
    }
  });
}

const sse = (chunks: string[]) =>
  chunks.map((c) => 'data: {"choices":[{"delta":{"content":' + JSON.stringify(c) + "}}]}").join("\n\n") +
  "\n\ndata: [DONE]\n\n";

const MSG = { channel: "demo", model: "demo-model", messages: [{ role: "user", content: "hi" }] };

describe("demo 模式", () => {
  it("demo 關（或只開一半沒設渠道）→ 匿名照樣 401", async () => {
    expect((await chatPost(anonChat(MSG))).status).toBe(401);
    await setS("demo_mode", "1"); // 沒設 demo_channel＝不生效
    expect((await chatPost(anonChat(MSG))).status).toBe(401);
    // /api/settings 對外也回 demo:false
    const s: any = await (await settingsGet(makeCtx({ url: ORIGIN + "/api/settings" }))).json();
    expect(s.demo).toBe(false);
  });

  it("開→匿名可聊：SSE 正常、對話落在 demo:public 名下、req_log 也是、沒填上限就不壓 max_tokens", async () => {
    await seedChannel({ slug: "demo", kind: "openai", base_url: UP, models: "demo-model" });
    await demoOn("demo");
    let upBody: any = null;
    fetchMock
      .get(UP)
      .intercept({
        path: "/v1/chat/completions",
        method: "POST",
        body(b) {
          upBody = JSON.parse(String(b));
          return true;
        }
      })
      .reply(200, sse(["你好", "！"]), { headers: { "content-type": "text/event-stream" } });

    const ctx = anonChat(MSG);
    const resp = await chatPost(ctx);
    expect(resp.status).toBe(200);
    const events = sseEvents(await readAll(resp));
    await drainWaits(ctx);
    expect(events[0].demo).toBe(true); // 標 demo：前端別去動對話列表
    expect(events[0].conv).toBeGreaterThan(0); // 但照樣給編號，後續訊息才串得起來
    // 增量會批次合併（CPU 上限的解法），切分點是實作細節 → 驗合起來的內容
    expect(
      events
        .filter((e) => e.d)
        .map((e) => e.d)
        .join("")
    ).toBe("你好！");
    expect(events[events.length - 1].done).toBe(true);
    expect(upBody.max_tokens).toBeUndefined(); // demo_max_tokens 沒填＝不限（跟會員路徑一樣）

    // 對話落地了，但擁有者是永遠不可能登入的 demo:public（只有管理員的總表看得到）
    const convs = (
      await env.DB.prepare(
        "SELECT c.*, u.google_sub AS sub FROM pg_conversations c JOIN users u ON u.id=c.user_id"
      ).all()
    ).results as any[];
    expect(convs.length).toBe(1);
    expect(convs[0].sub).toBe("demo:public");
    expect(convs[0].id).toBe(events[0].conv);
    const msgs = (await env.DB.prepare("SELECT * FROM pg_messages ORDER BY id").all()).results as any[];
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(msgs[1].content).toBe("你好！");
    const logs = (
      await env.DB.prepare(
        "SELECT r.*, u.google_sub AS sub FROM req_log r JOIN users u ON u.id=r.user_id"
      ).all()
    ).results as any[];
    expect(logs.length).toBe(1);
    expect(logs[0].sub).toBe("demo:public");
    expect(logs[0].svc).toBe("pg");
    // /api/settings 對外 demo:true；models 匿名拿得到白名單組（渠道名遮成「體驗模式」）
    const s: any = await (await settingsGet(makeCtx({ url: ORIGIN + "/api/settings" }))).json();
    expect(s.demo).toBe(true);
    const m: any = await (await modelsGet(makeCtx({ url: ORIGIN + "/api/playground/models" }))).json();
    expect(m.demo).toBe(true);
    expect(m.rows[0].name).toBe("體驗模式");
    expect(m.rows[0].models).toEqual(["demo-model"]);
  });

  it("同一頁的第二則訊息續在同一則對話；訪客拿不到任何歷史（列表／讀取／刪除都要登入）", async () => {
    await seedChannel({ slug: "demo", kind: "openai", base_url: UP, models: "demo-model" });
    await demoOn("demo");
    const reply = (t: string) =>
      fetchMock
        .get(UP)
        .intercept({ path: "/v1/chat/completions", method: "POST" })
        .reply(200, sse([t]), { headers: { "content-type": "text/event-stream" } });

    reply("一");
    const c1 = anonChat(MSG);
    const ev1 = sseEvents(await readAll(await chatPost(c1)));
    await drainWaits(c1);
    const conv = ev1[0].conv;

    // 前端把拿到的編號帶回來 → 續在同一則，不是開新的
    reply("二");
    const c2 = anonChat({
      ...MSG,
      conv_id: conv,
      messages: [...MSG.messages, { role: "user", content: "再問" }]
    });
    const ev2 = sseEvents(await readAll(await chatPost(c2)));
    await drainWaits(c2);
    expect(ev2[0].conv).toBe(conv);
    const convs = (await env.DB.prepare("SELECT * FROM pg_conversations").all()).results as any[];
    expect(convs.length).toBe(1);
    const msgs = (await env.DB.prepare("SELECT * FROM pg_messages ORDER BY id").all()).results as any[];
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);

    // 訪客那一側：三支端點全要登入 — 拿到編號也讀不出內容、刪不掉
    expect((await convListGet(makeCtx({ url: ORIGIN + "/api/playground/conversations" }))).status).toBe(401);
    const one = { url: ORIGIN + "/api/playground/conversations/" + conv, params: { id: String(conv) } };
    expect((await convGet(makeCtx(one))).status).toBe(401);
    expect((await convDel(makeCtx({ ...one, init: { method: "DELETE" } }))).status).toBe(401);
  });

  it("填了 demo_max_tokens 才壓上游回覆長度", async () => {
    await seedChannel({ slug: "demo", kind: "openai", base_url: UP, models: "demo-model" });
    await demoOn("demo", { demo_max_tokens: "256" });
    let upBody: any = null;
    fetchMock
      .get(UP)
      .intercept({
        path: "/v1/chat/completions",
        method: "POST",
        body(b) {
          upBody = JSON.parse(String(b));
          return true;
        }
      })
      .reply(200, sse(["ok"]), { headers: { "content-type": "text/event-stream" } });

    const ctx = anonChat(MSG);
    const resp = await chatPost(ctx);
    expect(resp.status).toBe(200);
    await readAll(resp);
    await drainWaits(ctx);
    expect(upBody.max_tokens).toBe(256);
  });

  it("鎖定：非指定渠道 403（先擋、探測不到）；白名單外的模型 403", async () => {
    await seedChannel({ slug: "demo", kind: "openai", base_url: UP, models: "demo-model,other-model" });
    await seedChannel({ slug: "secret", kind: "openai", base_url: UP, models: "x" });
    await demoOn("demo", { demo_models: "demo-model" });
    const r1 = await chatPost(anonChat({ channel: "secret", model: "x", messages: MSG.messages }));
    expect(r1.status).toBe(403);
    expect(((await r1.json()) as any).error).toBe("demo-locked");
    const r2 = await chatPost(anonChat({ channel: "demo", model: "other-model", messages: MSG.messages }));
    expect(r2.status).toBe(403);
  });

  it("輸入超過 4k 字 → 400", async () => {
    await seedChannel({ slug: "demo", kind: "openai", base_url: UP, models: "demo-model" });
    await demoOn("demo");
    const r = await chatPost(
      anonChat({
        channel: "demo",
        model: "demo-model",
        messages: [{ role: "user", content: "喂".repeat(4001) }]
      })
    );
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).error).toBe("demo-too-long");
  });

  it("IP 日額用完 → 429（第二發被 DO 擋、不打上游）", async () => {
    await seedChannel({ slug: "demo", kind: "openai", base_url: UP, models: "demo-model" });
    await demoOn("demo", { demo_per_ip_day: "1", contact_url: "https://t.me/site_admin" });
    fetchMock
      .get(UP)
      .intercept({ path: "/v1/chat/completions", method: "POST" })
      .reply(200, sse(["ok"]), { headers: { "content-type": "text/event-stream" } });
    const c1 = anonChat(MSG, "198.51.100.1");
    const r1 = await chatPost(c1);
    expect(r1.status).toBe(200);
    await readAll(r1); // SSE 要讀完，寫入端才不會被 backpressure 卡住
    await drainWaits(c1);
    const r2 = await chatPost(anonChat(MSG, "198.51.100.1"));
    expect(r2.status).toBe(429);
    const b2: any = await r2.json();
    expect(b2.error).toBe("demo-rate-limited");
    // 額度用完＝管理員幫得上忙 → 附聯絡方式：欄位給前端畫「聯絡我」鈕、
    // hint 尾端那份給沒有前端可以畫按鈕的呼叫端（跟會員 quota 429 同一套）
    expect(b2.contact_url).toBe("https://t.me/site_admin");
    expect(String(b2.hint).endsWith("：https://t.me/site_admin")).toBe(true);
  });

  it("每分鐘上限的 429 不附聯絡方式（等一下就好，不必找人）", async () => {
    await seedChannel({ slug: "demo", kind: "openai", base_url: UP, models: "demo-model" });
    await demoOn("demo", { demo_per_min: "1", contact_url: "https://t.me/site_admin" });
    fetchMock
      .get(UP)
      .intercept({ path: "/v1/chat/completions", method: "POST" })
      .reply(200, sse(["ok"]), { headers: { "content-type": "text/event-stream" } });
    const c1 = anonChat(MSG, "198.51.100.7");
    const r1 = await chatPost(c1);
    expect(r1.status).toBe(200);
    await readAll(r1);
    await drainWaits(c1);
    const r2 = await chatPost(anonChat(MSG, "198.51.100.7"));
    expect(r2.status).toBe(429);
    const b2: any = await r2.json();
    expect(b2.error).toBe("demo-rate-limited");
    expect(b2.contact_url).toBeUndefined();
    expect(String(b2.hint)).toContain("請稍等再試");
  });

  it("全站日額用完 → 換 IP 也 429", async () => {
    await seedChannel({ slug: "demo", kind: "openai", base_url: UP, models: "demo-model" });
    await demoOn("demo", {
      demo_global_day: "1",
      demo_per_ip_day: "99",
      contact_url: "https://t.me/site_admin"
    });
    fetchMock
      .get(UP)
      .intercept({ path: "/v1/chat/completions", method: "POST" })
      .reply(200, sse(["ok"]), { headers: { "content-type": "text/event-stream" } });
    const c1 = anonChat(MSG, "198.51.100.1");
    const r1 = await chatPost(c1);
    expect(r1.status).toBe(200);
    await readAll(r1);
    await drainWaits(c1);
    const r2 = await chatPost(anonChat(MSG, "198.51.100.2")); // 不同 IP
    expect(r2.status).toBe(429);
    const b2: any = await r2.json();
    expect(b2.error).toBe("demo-quota-exceeded");
    expect(b2.contact_url).toBe("https://t.me/site_admin");
  });

  it("DO 沒綁定（模擬故障）→ 503 絕不放行，errlog 留 demo.do", async () => {
    await seedChannel({ slug: "demo", kind: "openai", base_url: UP, models: "demo-model" });
    await demoOn("demo");
    const ctx = makeCtx({
      url: ORIGIN + "/api/playground/chat",
      init: {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/json", "cf-connecting-ip": "1.1.1.1" },
        body: JSON.stringify(MSG)
      },
      env: envWith({ RATE_LIMITER: undefined })
    });
    const r = await chatPost(ctx);
    expect(r.status).toBe(503);
    expect(((await r.json()) as any).error).toBe("demo-unavailable");
    const errs = (await env.DB.prepare("SELECT src FROM errlog").all()).results as any[];
    expect(errs.map((e) => e.src)).toContain("demo.do");
  });

  it("登入但沒批准的會員不會誤入 demo（照樣 403）", async () => {
    await seedChannel({ slug: "demo", kind: "openai", base_url: UP, models: "demo-model" });
    await demoOn("demo");
    const { seedUser } = await import("../helpers.js");
    const { createSession } = await import("../../src/lib/auth.js");
    const u = await seedUser({ status: "approved", services: "relay" }); // 沒 playground
    const sess = await createSession(env, u, new URL(ORIGIN + "/"));
    const ctx = makeCtx({
      url: ORIGIN + "/api/playground/chat",
      init: {
        method: "POST",
        headers: {
          cookie: "ipua_sess=" + sess.sid,
          origin: ORIGIN,
          "content-type": "application/json"
        },
        body: JSON.stringify(MSG)
      }
    });
    expect((await chatPost(ctx)).status).toBe(403);
  });
});
