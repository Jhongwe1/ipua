// functions/_middleware.js — 訪客紀錄的 shouldLog 判斷矩陣。
// shouldLog 沒對外 export，所以透過 onRequest 驅動：用一顆「記錄型」假 DB 觀測
// 到底有沒有寫入 visits（順便驗 logVisit 的 SQL 綁定不會炸）。
import { describe, it, expect } from "vitest";
import { onRequest } from "../../functions/_middleware.js";
import { ORIGIN } from "../helpers.js";

// 假 DB：只認 INSERT INTO visits，記下呼叫次數；其餘語句照樣回傳 no-op。
function recordingEnv() {
  const state = { inserts: 0 };
  const stmt = (sql) => ({
    bind: () => ({ run: async () => { if (/INSERT INTO visits/i.test(sql)) state.inserts++; return { success: true }; } }),
    first: async () => null,
    all: async () => ({ results: [] })
  });
  return { env: { DB: { prepare: stmt } }, state };
}

// 驅動一次請求並等背景寫入跑完；回傳 inserts 次數。
async function run(path, opts) {
  opts = opts || {};
  const { env, state } = recordingEnv();
  const waits = [];
  const ctx = {
    request: new Request(ORIGIN + path, { method: opts.method || "GET", headers: opts.headers || {} }),
    env,
    waitUntil: (p) => waits.push(Promise.resolve(p)),
    next: async () => new Response("ok")
  };
  const r = await onRequest(ctx);
  await Promise.allSettled(waits);
  return { logged: state.inserts > 0, resp: r };
}

const HTML = { accept: "text/html" };

describe("shouldLog：會記錄的頁面瀏覽", () => {
  it("首頁與工具頁（Accept: text/html）", async () => {
    for (const p of ["/", "/ip", "/ua", "/news", "/articles"]) {
      expect((await run(p, { headers: HTML })).logged).toBe(true);
    }
  });
  it("動態文章頁與自訂頁面（樣式比對，免 Accept）", async () => {
    expect((await run("/news/12")).logged).toBe(true);
    expect((await run("/articles/345")).logged).toBe(true);
    expect((await run("/p/about")).logged).toBe(true);
  });
  it("尾斜線正規化：/news/ 等同 /news", async () => {
    expect((await run("/news/", { headers: HTML })).logged).toBe(true);
  });
});

describe("shouldLog：不記錄的請求", () => {
  it("API／管理頁／圖片／登入／中轉／VPN 抓取一律不記", async () => {
    for (const p of ["/api/me", "/api/health", "/logs", "/admin", "/img/5",
                     "/auth/login", "/auth/callback", "/relay/openai/v1/models", "/vpn/sub/uvtabc"]) {
      expect((await run(p, { headers: HTML })).logged).toBe(false);
    }
  });
  it("非 GET/HEAD（POST/PUT…）不記", async () => {
    expect((await run("/news", { method: "POST", headers: HTML })).logged).toBe(false);
    expect((await run("/", { method: "PUT", headers: HTML })).logged).toBe(false);
  });
  it("HEAD 記（也是頁面瀏覽）", async () => {
    expect((await run("/", { method: "HEAD", headers: HTML })).logged).toBe(true);
  });
  it("預先抓取（sec-purpose: prefetch）不記", async () => {
    expect((await run("/news", { headers: { accept: "text/html", "sec-purpose": "prefetch" } })).logged).toBe(false);
    expect((await run("/", { headers: { accept: "text/html", purpose: "prefetch" } })).logged).toBe(false);
  });
  it("非頁面路徑且沒帶 text/html Accept（多為靜態資產請求）不記", async () => {
    expect((await run("/assets/account.js", { headers: { accept: "*/*" } })).logged).toBe(false);
    expect((await run("/favicon.ico")).logged).toBe(false);
  });
  it("沒帶 Accept 但打固定頁面路徑（機器人）仍記", async () => {
    expect((await run("/")).logged).toBe(true);
    expect((await run("/ip")).logged).toBe(true);
  });
});

describe("中介層永不影響網站本體", () => {
  it("一律 return next() 的回應", async () => {
    const { resp } = await run("/news", { headers: HTML });
    expect(await resp.text()).toBe("ok");
  });
  it("沒有 env.DB 也不炸、照樣放行", async () => {
    const waits = [];
    const ctx = {
      request: new Request(ORIGIN + "/news", { headers: HTML }),
      env: {},
      waitUntil: (p) => waits.push(Promise.resolve(p)),
      next: async () => new Response("ok")
    };
    const r = await onRequest(ctx);
    expect(await r.text()).toBe("ok");
  });
});
