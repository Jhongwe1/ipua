// POST /api/playground/chat — SSE 快樂路徑、D1 持久化、錯誤淨化（會員看不到上游身分）。
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { env, fetchMock } from "cloudflare:test";
import { onRequestPost } from "../../functions/api/playground/chat.js";
import { createSession } from "../../lib/auth.js";
import { makeCtx, drainWaits, seedUser, seedAdmin, seedChannel, readAll, sseEvents, ORIGIN } from "../helpers.js";

const UP = "https://api.example.com";

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

async function chatCtx(user, body) {
  const sess = await createSession(env, user, new URL(ORIGIN + "/"));
  return makeCtx({
    url: ORIGIN + "/api/playground/chat",
    init: {
      method: "POST",
      headers: {
        cookie: "ipua_sess=" + sess.sid,
        origin: ORIGIN,
        "content-type": "application/json"
      },
      body: JSON.stringify(body)
    }
  });
}

const openaiSSE = (chunks) =>
  chunks.map((c) => 'data: {"choices":[{"delta":{"content":' + JSON.stringify(c) + '}}]}').join("\n\n") +
  "\n\ndata: [DONE]\n\n";

describe("playground chat", () => {
  it("未登入 → 401；沒 playground 服務 → 403", async () => {
    const ctx = makeCtx({
      url: ORIGIN + "/api/playground/chat",
      init: { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }
    });
    expect((await onRequestPost(ctx)).status).toBe(401);

    const noSvc = await seedUser({ status: "approved", services: "relay" });
    const ctx2 = await chatCtx(noSvc, { channel: "c", model: "m", messages: [{ role: "user", content: "hi" }] });
    expect((await onRequestPost(ctx2)).status).toBe(403);
  });

  it("快樂路徑：SSE 串流→統一事件→存 D1（新對話＋user＋assistant）", async () => {
    const user = await seedUser({ status: "approved", services: "playground" });
    await seedChannel({ slug: "pg", kind: "openai", base_url: UP, models: "gpt-t" });
    fetchMock.get(UP).intercept({ path: "/v1/chat/completions", method: "POST" })
      .reply(200, openaiSSE(["你", "好"]), { headers: { "content-type": "text/event-stream" } });

    const ctx = await chatCtx(user, { channel: "pg", model: "gpt-t", messages: [{ role: "user", content: "打招呼" }] });
    const resp = await onRequestPost(ctx);
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toContain("text/event-stream");

    const events = sseEvents(await readAll(resp));
    await drainWaits(ctx);
    expect(events[0].conv).toBeGreaterThan(0);
    expect(events[0].title).toBe("打招呼");
    expect(events.filter((e) => e.d).map((e) => e.d).join("")).toBe("你好");
    expect(events[events.length - 1].done).toBe(true);

    const convId = events[0].conv;
    const msgs = await env.DB.prepare("SELECT role,content FROM pg_messages WHERE conv_id=?1 ORDER BY id").bind(convId).all();
    expect(msgs.results.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(msgs.results[1].content).toBe("你好");
    const conv = await env.DB.prepare("SELECT * FROM pg_conversations WHERE id=?1").bind(convId).first();
    expect(conv.user_id).toBe(user.id);
    expect(conv.model).toBe("gpt-t");
  });

  it("模型不在渠道清單 → 400；渠道不存在 → 404", async () => {
    const user = await seedUser({ status: "approved", services: "playground" });
    await seedChannel({ slug: "pg2", models: "only-this" });
    const bad = await chatCtx(user, { channel: "pg2", model: "other", messages: [{ role: "user", content: "x" }] });
    expect((await onRequestPost(bad)).status).toBe(400);
    const none = await chatCtx(user, { channel: "ghost", model: "m", messages: [{ role: "user", content: "x" }] });
    expect((await onRequestPost(none)).status).toBe(404);
  });

  it("上游先失敗（HTTP 500）：會員只看安全分類字、站長看得到原文", async () => {
    const member = await seedUser({ status: "approved", services: "playground" });
    await seedChannel({ slug: "pg3", base_url: UP, models: "m" });
    fetchMock.get(UP).intercept({ path: "/v1/chat/completions", method: "POST" })
      .reply(500, '{"error":{"message":"secret provider detail"}}');

    const ctx = await chatCtx(member, { channel: "pg3", model: "m", messages: [{ role: "user", content: "x" }] });
    const r = await onRequestPost(ctx);
    await drainWaits(ctx);            // 埋點（errlog）是背景寫入，要等它收尾
    expect(r.status).toBe(502);
    const j = await r.json();
    expect(j.error).toBe("upstream-error");
    expect(j.detail).toBeUndefined();                      // 原文不外洩
    expect(JSON.stringify(j)).not.toContain("secret provider detail");
    expect(j.conv).toBeGreaterThan(0);                     // 對話已建，user 訊息不丟

    const admin = await seedAdmin();
    fetchMock.get(UP).intercept({ path: "/v1/chat/completions", method: "POST" })
      .reply(500, '{"error":{"message":"secret provider detail"}}');
    const ctx2 = await chatCtx(admin, { channel: "pg3", model: "m", messages: [{ role: "user", content: "x" }] });
    const j2 = await (await onRequestPost(ctx2)).json();
    await drainWaits(ctx2);
    expect(j2.detail).toContain("secret provider detail"); // 站長除錯用
    // 埋點：上游 5xx 也留了站內錯誤（src=pg.upstream）
    const errs = await env.DB.prepare("SELECT COUNT(*) c FROM errlog WHERE src='pg.upstream'").first();
    expect(errs.c).toBe(2);
  });

  it("串流中途上游夾錯誤：已生成部分照存、會員拿到淨化訊息", async () => {
    const user = await seedUser({ status: "approved", services: "playground" });
    await seedChannel({ slug: "pg4", base_url: UP, models: "m" });
    const body = 'data: {"choices":[{"delta":{"content":"部分"}}]}\n\n' +
                 'data: {"error":{"message":"provider blew up"}}\n\n';
    fetchMock.get(UP).intercept({ path: "/v1/chat/completions", method: "POST" })
      .reply(200, body, { headers: { "content-type": "text/event-stream" } });

    const ctx = await chatCtx(user, { channel: "pg4", model: "m", messages: [{ role: "user", content: "x" }] });
    const events = sseEvents(await readAll(await onRequestPost(ctx)));
    await drainWaits(ctx);
    const errEv = events.find((e) => e.error);
    expect(errEv).toBeTruthy();
    expect(errEv.hint).not.toContain("provider blew up");  // 淨化
    const convId = events[0].conv;
    const saved = await env.DB.prepare(
      "SELECT content FROM pg_messages WHERE conv_id=?1 AND role='assistant'"
    ).bind(convId).first();
    expect(saved.content).toBe("部分");                     // 部分內容留住
  });

  it("上游不理串流、直接回整包 JSON → 一次送完（備援路徑）", async () => {
    const user = await seedUser({ status: "approved", services: "playground" });
    await seedChannel({ slug: "pg5", base_url: UP, models: "m" });
    fetchMock.get(UP).intercept({ path: "/v1/chat/completions", method: "POST" })
      .reply(200, '{"choices":[{"message":{"content":"整包回覆"}}]}',
        { headers: { "content-type": "application/json" } });

    const ctx = await chatCtx(user, { channel: "pg5", model: "m", messages: [{ role: "user", content: "x" }] });
    const events = sseEvents(await readAll(await onRequestPost(ctx)));
    await drainWaits(ctx);
    expect(events.find((e) => e.d).d).toBe("整包回覆");
    expect(events[events.length - 1].done).toBe(true);
  });

  it("帶既有 conv_id 續聊；別人的對話 → 404", async () => {
    const user = await seedUser({ status: "approved", services: "playground" });
    const other = await seedUser({ status: "approved", services: "playground" });
    await seedChannel({ slug: "pg6", base_url: UP, models: "m" });
    const now = new Date().toISOString();
    const conv = await env.DB.prepare(
      "INSERT INTO pg_conversations (user_id,title,channel,model,created_at,updated_at) VALUES (?1,'t','pg6','m',?2,?2)"
    ).bind(other.id, now).run();
    const ctx = await chatCtx(user, {
      conv_id: conv.meta.last_row_id, channel: "pg6", model: "m",
      messages: [{ role: "user", content: "偷看" }]
    });
    expect((await onRequestPost(ctx)).status).toBe(404);
  });
});
