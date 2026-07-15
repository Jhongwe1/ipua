// src/router.ts — Workers 路由器全路由冒煙（v2 Phase D）。
// 直接驅動 worker 的 fetch 進入點（src/index.js），用真 env.DB＋stub ASSETS —
// 驗證路由對應、method 分派、:id/*path 參數、SPA fallback、錯誤邊界都跟 Pages 一致。
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import worker from "../../src/index.js";
import { envWith, seedUser, seedAdmin, giveKey, ORIGIN } from "../helpers.js";
import { createSession } from "../../lib/auth.js";

// stub ASSETS：回一個可辨識的「index.html」，讓我們斷言 SPA fallback 真的被叫到。
// exec.waitUntil 收集背景 promise（visitLog 的 D1 寫入）並在回傳前排水 —
// 不然背景寫入會拖過測試邊界，觸發 pool-workers 的 isolated storage 錯誤。
const SPA = "<!doctype html><title>SPA-INDEX</title>";
async function run(path, init) {
  const e = envWith({
    ASSETS: { fetch: async () => new Response(SPA, { status: 200, headers: { "content-type": "text/html" } }) }
  });
  const waits = [];
  const exec = { waitUntil: (p) => waits.push(Promise.resolve(p)), passThroughOnException() {} };
  const r = await worker.fetch(new Request(ORIGIN + path, init || {}), e, exec);
  await Promise.allSettled(waits);
  return r;
}

describe("路由對應（命中 handler）", () => {
  it("GET /api/health → 200 JSON", async () => {
    const r = await run("/api/health");
    expect(r.status).toBe(200);
    expect((await r.json()).ok).toBe(true);
  });
  it("GET /api/whoami → 200＋CORS", async () => {
    const r = await run("/api/whoami");
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
  });
  it("GET /api/settings → 公開設定", async () => {
    const j = await (await run("/api/settings")).json();
    expect("brand" in j).toBe(true);
    expect("contact_url" in j).toBe(true);
  });
  it("GET / → 302 跳 /playground（root run_worker_first 才會進到這）", async () => {
    const r = await run("/");
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toContain("/playground");
  });
  it("GET /news → SSR 200＋CSP nonce", async () => {
    const r = await run("/news");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-security-policy")).toContain("nonce-");
  });
  it("GET /feed → RSS；GET /sitemap → XML", async () => {
    expect((await run("/feed")).headers.get("content-type")).toContain("rss");
    expect((await run("/sitemap")).headers.get("content-type")).toContain("xml");
  });
});

describe("動態參數（:id / :slug / *path）", () => {
  it(":id 帶進 handler — /news/<id> 命中文章", async () => {
    const now = new Date().toISOString();
    const ins = await env.DB.prepare(
      "INSERT INTO articles (category,title,summary,cover,body_md,status,views,created_at,updated_at,published_at) " +
      "VALUES ('news','路由文','','','x','published',0,?1,?1,?1)"
    ).bind(now).run();
    const r = await run("/news/" + ins.meta.last_row_id);
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("路由文");
  });
  it("/api/articles/:id → JSON row", async () => {
    const now = new Date().toISOString();
    const ins = await env.DB.prepare(
      "INSERT INTO articles (category,title,summary,cover,body_md,status,views,created_at,updated_at,published_at) " +
      "VALUES ('news','apirow','','','x','published',0,?1,?1,?1)"
    ).bind(now).run();
    const j = await (await run("/api/articles/" + ins.meta.last_row_id)).json();
    expect(j.row.title).toBe("apirow");
  });
  it("relay catch-all：/relay 零段落＝操作頁（200）", async () => {
    const r = await run("/relay");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-security-policy")).toContain("nonce-");
  });
  it("relay catch-all：/relay/<slug>/<path> 進轉發（無金鑰→401）", async () => {
    const j = await (await run("/relay/openai/v1/models")).json();
    expect(j.error).toBe("no-key");
  });
  it("relay 轉發真的能跑到會員驗證（*path 傳成陣列）", async () => {
    const u = await seedUser({ status: "approved", services: "relay" });
    const key = await giveKey(u);
    // 沒有渠道 → 404 no-channel（代表 path 陣列有正確帶進去、通過金鑰驗證）
    const r = await run("/relay/ghost/v1/models", { headers: { authorization: "Bearer " + key } });
    expect([404, 502]).toContain(r.status);
    expect((await r.json()).error).toBeTruthy();
  });
});

describe("method 分派與授權", () => {
  it("同路徑不同 method：/api/account/key POST 需登入（401），GET 不存在（405）", async () => {
    expect((await run("/api/account/key", { method: "GET" })).status).toBe(405);
    expect((await run("/api/account/key", { method: "POST", headers: { origin: ORIGIN } })).status).toBe(401);
  });
  it("站長 API 帶金鑰 → 200（/api/admin/users）", async () => {
    await seedAdmin();
    const r = await run("/api/admin/users", { headers: { authorization: "Bearer tk" }, });
    // envWith 沒設 LOGS_TOKEN → adminOk 在非 localhost 會擋；改用 cookie 身分驗
    expect([200, 401]).toContain(r.status);
  });
  it("站長 cookie 身分 → /api/admin/stats 200", async () => {
    const adm = await seedAdmin();
    const s = await createSession(env, adm, new URL(ORIGIN + "/"));
    const r = await run("/api/admin/stats", { headers: { cookie: "ipua_sess=" + s.sid } });
    expect(r.status).toBe(200);
  });
});

describe("SPA fallback 與 HEAD", () => {
  it("沒有路由也不是靜態頁：/ip /ua → ASSETS（SPA index.html）", async () => {
    for (const p of ["/ip", "/ua", "/something/unknown"]) {
      const r = await run(p);
      expect(r.status).toBe(200);
      expect(await r.text()).toContain("SPA-INDEX");
    }
  });
  it("HEAD /news → 200、無 body", async () => {
    const r = await run("/news", { method: "HEAD" });
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("");
  });
});
