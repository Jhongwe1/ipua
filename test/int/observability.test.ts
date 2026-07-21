// Phase D 可觀測性：/api/health、/api/admin/errors、/api/admin/stats、/api/csp-report、
// 以及 relay／playground 的 errlog 埋點有真的寫進去。
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { env, fetchMock } from "cloudflare:test";
import { onRequestGet as healthGet } from "../../src/routes/api/health.js";
import { onRequestGet as errsGet, onRequestDelete as errsDel } from "../../src/routes/api/admin/errors.js";
import { onRequestGet as statsGet } from "../../src/routes/api/admin/stats.js";
import { onRequestPost as cspPost } from "../../src/routes/api/csp-report.js";
import { onRequest as relayHandler } from "../../src/routes/relay/[[path]].js";
import { reportErrorNow } from "../../src/lib/observe.js";
import { VERSION } from "../../src/lib/site.js";
import { logReq } from "../../src/lib/quota.js";
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
    const j: any = await r.json();
    expect(j.ok).toBe(true);
    // 對 VERSION 常數本身斷言（不重抄字面值）—— 抄一份就是多一個會漂的地方，
    // 這裡要驗的是「/api/health 真的把站台版本接出去了」，不是版本號等於某個字串。
    expect(j.version).toBe(VERSION);
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
    const j: any = await (await errsGet(ctx)).json();
    expect(j.total).toBe(2);
    expect(j.rows.length).toBe(1);
    expect(j.rows[0].msg).toBe("第二筆"); // 新的在前

    const del = makeCtx({
      url: ORIGIN + "/api/admin/errors",
      init: { method: "DELETE", headers: AUTH },
      env: E()
    });
    expect((await errsDel(del)).status).toBe(200);
    const after: any = await (
      await errsGet(makeCtx({ url: ORIGIN + "/api/admin/errors", init: { headers: AUTH }, env: E() }))
    ).json();
    expect(after.total).toBe(0);
  });

  it("src 過濾", async () => {
    await reportErrorNow(env, "relay.upstream", "a");
    await reportErrorNow(env, "pg.stream", "b");
    const ctx = makeCtx({
      url: ORIGIN + "/api/admin/errors?src=pg.stream",
      init: { headers: AUTH },
      env: E()
    });
    const j: any = await (await errsGet(ctx)).json();
    expect(j.total).toBe(1);
    expect(j.rows[0].src).toBe("pg.stream");
  });
});

describe("/api/admin/stats", () => {
  it("彙總每日／渠道×模型＋原始 durs", async () => {
    const u = await seedUser({ status: "approved" });
    await logReq(env, {
      user_id: u.id,
      svc: "relay",
      channel: "c1",
      model: "m1",
      status: 200,
      dur_ms: 100,
      ttfb_ms: 40,
      tokens_in: 10,
      tokens_out: 20
    });
    await logReq(env, { user_id: u.id, svc: "relay", channel: "c1", model: "m1", status: 502, dur_ms: 300 });
    await logReq(env, {
      user_id: u.id,
      svc: "pg",
      channel: "c2",
      model: "m2",
      status: 200,
      dur_ms: 200,
      tokens_in: 5,
      tokens_out: 6
    });
    const ctx = makeCtx({ url: ORIGIN + "/api/admin/stats?days=7", init: { headers: AUTH }, env: E() });
    const j: any = await (await statsGet(ctx)).json();
    expect(j.days).toBe(7);
    const relayDay = j.by_day.find((r: any) => r.svc === "relay");
    expect(relayDay.n).toBe(2);
    expect(relayDay.errs).toBe(1);
    expect(relayDay.avg_dur).toBe(200);
    const ch = j.by_channel.find((r: any) => r.channel === "c1" && r.model === "m1");
    expect(ch.n).toBe(2);
    expect(ch.tokens_in).toBe(10);
    expect(j.durs.length).toBe(3);
  });
  it("days 界限外自動回 7", async () => {
    const ctx = makeCtx({ url: ORIGIN + "/api/admin/stats?days=999", init: { headers: AUTH }, env: E() });
    expect(((await (await statsGet(ctx)).json()) as any).days).toBe(7);
  });
});

describe("/api/csp-report", () => {
  it("永遠 204；取樣寫入 errlog（Math.random stub 保證取樣命中）", async () => {
    const orig = Math.random;
    Math.random = () => 0.05; // < 0.1 → 必取樣
    try {
      const body = JSON.stringify({
        "csp-report": {
          "violated-directive": "script-src",
          "document-uri": "https://uaip.cc.cd/x",
          "blocked-uri": "https://evil.com/a.js"
        }
      });
      const ctx = makeCtx({ url: ORIGIN + "/api/csp-report", init: { method: "POST", body } });
      const r = await cspPost(ctx);
      expect(r.status).toBe(204);
      const row = await env.DB.prepare(
        "SELECT * FROM errlog WHERE src='csp' ORDER BY id DESC LIMIT 1"
      ).first<any>();
      expect(row.msg).toContain("script-src");
      expect(row.msg).toContain("evil.com");
    } finally {
      Math.random = orig;
    }
  });
  it("沒被取樣時什麼都不寫、照樣 204", async () => {
    const orig = Math.random;
    Math.random = () => 0.9;
    try {
      const ctx = makeCtx({ url: ORIGIN + "/api/csp-report", init: { method: "POST", body: "junk" } });
      expect((await cspPost(ctx)).status).toBe(204);
      const n = await env.DB.prepare("SELECT COUNT(*) c FROM errlog").first<any>();
      expect(n.c).toBe(0);
    } finally {
      Math.random = orig;
    }
  });

  // 這是全站唯一的匿名 D1 寫入口，而 errlog 正是 tgAlertScan 每 5 分鐘撈去推 Telegram 的表
  // ——沒有限流的話，持續 POST ＝ D1 寫入放大 ＋ 攻擊者可控文字直達管理員的 Telegram。
  it("同一個 IP 連續轟炸：超過每分鐘上限之後就不再寫入（仍然 204）", async () => {
    const orig = Math.random;
    Math.random = () => 0.05; // 全部命中取樣，把壓力直接推到限流器
    try {
      const post = () =>
        cspPost(
          makeCtx({
            url: ORIGIN + "/api/csp-report",
            init: {
              method: "POST",
              headers: { "cf-connecting-ip": "203.0.113.9" },
              body: JSON.stringify({ "csp-report": { "violated-directive": "img-src" } })
            }
          })
        );
      for (let i = 0; i < 25; i++) expect((await post()).status).toBe(204); // 對外一律 204
      const n = await env.DB.prepare("SELECT COUNT(*) c FROM errlog WHERE src='csp'").first<any>();
      expect(n.c).toBeGreaterThan(0); // 前幾筆有進去（限流不是把功能關掉）
      expect(n.c).toBeLessThanOrEqual(5); // 但被每分鐘上限擋在 5 筆（CSP_RATE.perMin）
    } finally {
      Math.random = orig;
    }
  });

  it("不同 IP 各自計數（限流是 per-IP，不是全站一條）", async () => {
    const orig = Math.random;
    Math.random = () => 0.05;
    try {
      const post = (ip: string) =>
        cspPost(
          makeCtx({
            url: ORIGIN + "/api/csp-report",
            init: {
              method: "POST",
              headers: { "cf-connecting-ip": ip },
              body: JSON.stringify({ "csp-report": { "violated-directive": "font-src" } })
            }
          })
        );
      for (let i = 0; i < 6; i++) await post("198.51.100.1");
      for (let i = 0; i < 6; i++) await post("198.51.100.2");
      const n = await env.DB.prepare("SELECT COUNT(*) c FROM errlog WHERE src='csp'").first<any>();
      expect(n.c).toBe(10); // 兩個 IP 各自吃滿 5 筆，而不是合計 5 筆
    } finally {
      Math.random = orig;
    }
  });

  it("限流器沒綁定 → 不寫（匿名寫入口在擋不住的時候要關起來，不是照寫）", async () => {
    const orig = Math.random;
    Math.random = () => 0.05;
    try {
      const noDo = envWith({ RATE_LIMITER: undefined });
      const ctx = makeCtx({
        url: ORIGIN + "/api/csp-report",
        init: { method: "POST", body: JSON.stringify({ "csp-report": { "violated-directive": "x" } }) },
        env: noDo
      });
      expect((await cspPost(ctx)).status).toBe(204);
      const n = await env.DB.prepare("SELECT COUNT(*) c FROM errlog WHERE src='csp'").first<any>();
      expect(n.c).toBe(0);
    } finally {
      Math.random = orig;
    }
  });
});

describe("埋點：relay 上游故障進 errlog", () => {
  it("連不上上游 → errlog src=relay.upstream", async () => {
    const u = await seedUser({ status: "approved", services: "relay" });
    const key = await giveKey(u);
    await seedChannel({ slug: "ob1" });
    fetchMock
      .get("https://api.example.com")
      .intercept({ path: "/v1/models" })
      .replyWithError(new Error("boom"));
    const ctx = makeCtx({
      url: ORIGIN + "/relay/ob1/v1/models",
      init: { headers: { authorization: "Bearer " + key } },
      params: { path: ["ob1", "v1", "models"] }
    });
    const r = await relayHandler(ctx);
    expect(r.status).toBe(502);
    await drainWaits(ctx);
    const row = await env.DB.prepare(
      "SELECT * FROM errlog WHERE src='relay.upstream' ORDER BY id DESC LIMIT 1"
    ).first<any>();
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
    expect(r.status).toBe(503); // 會員照樣拿到上游原話
    await r.text();
    await drainWaits(ctx);
    const row = await env.DB.prepare(
      "SELECT * FROM errlog WHERE src='relay.upstream' ORDER BY id DESC LIMIT 1"
    ).first<any>();
    expect(row.msg).toContain("503");
  });
});

// errlog 是「攻擊者與第三方的文字」最容易落地的地方：
//   * chat.ts 把上游回應原文塞進 detail（主打的 custom 廉價轉售商常在錯誤訊息回顯完整金鑰）
//   * 這張表接著被 /api/admin/errors 讀、被每日 cron 備份進 R2、被 tgAlertScan 推去 Telegram
// 所以遮罩放在 observe 這一層（而不是各個呼叫點）——以後新增的 reportError 自動受保護。
describe("errlog 秘密遮罩（放在 observe 層，不是呼叫點）", () => {
  const cases: Array<[string, string]> = [
    ["OpenAI 系", "sk-proj-AbCdEf0123456789ghIJklMNop"],
    ["Anthropic", "sk-ant-api03-AbCdEf0123456789ghIJklMNop"],
    ["Google/Gemini", "AIzaSyA1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q"],
    ["本站會員金鑰", "uak-abcdefghijklmnopqrst"],
    ["Telegram bot token", "1234567890:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw"]
  ];

  for (const [label, secret] of cases) {
    it("上游錯誤內文含" + label + "金鑰 → errlog 不落明文", async () => {
      const msg = "upstream said: invalid api key " + secret + " for account";
      await reportErrorNow(env, "test.redact", msg, { detail: "raw body: " + secret });
      const row = await env.DB.prepare(
        "SELECT * FROM errlog WHERE src='test.redact' ORDER BY id DESC LIMIT 1"
      ).first<any>();
      expect(row.msg).not.toContain(secret);
      expect(row.detail).not.toContain(secret);
      // 但要留得下「這裡本來有一把什麼金鑰」——不然除錯時只剩一片空白
      expect(row.msg).toContain("redacted");
      // 周圍的文字要完好，遮罩不能把整句吃掉
      expect(row.msg).toContain("upstream said");
      expect(row.msg).toContain("for account");
    });
  }

  it("沒有秘密的訊息一字不動", async () => {
    const msg = "connect ETIMEDOUT 1.2.3.4:443 after 30s";
    await reportErrorNow(env, "test.redact.clean", msg);
    const row = await env.DB.prepare(
      "SELECT * FROM errlog WHERE src='test.redact.clean' ORDER BY id DESC LIMIT 1"
    ).first<any>();
    expect(row.msg).toBe(msg);
  });

  it("Error 物件的 stack 也走同一條遮罩", async () => {
    const err = new Error("bad key sk-proj-AbCdEf0123456789ghIJklMNop");
    await reportErrorNow(env, "test.redact.stack", err);
    const row = await env.DB.prepare(
      "SELECT * FROM errlog WHERE src='test.redact.stack' ORDER BY id DESC LIMIT 1"
    ).first<any>();
    expect(row.msg + "|" + row.detail).not.toContain("sk-proj-AbCdEf0123456789ghIJklMNop");
  });
});
