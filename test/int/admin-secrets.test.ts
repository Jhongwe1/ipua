// 「上游金鑰永遠不離開伺服器」—— 兩份 README 的頭號安全宣稱，在 2026-07 稽核前**零測試**。
//
// 為什麼需要這一檔（風險位置，不是覆蓋率）：
//   * 管理端點是 `SELECT *` 進 maskRow（relay channels/index.ts、vpn channels/index.ts 各一份），
//     所以「以後往 relay_channels 加一個欄位」就會靜默外洩 —— 沒有任何測試會紅。
//   * 既有的 relay 測試只驗了金鑰正確**注入上游**（test/int/relay.test.ts），
//     沒有一條驗它不會**流回來**。方向是反的。
//
// 兩個刻意的設計：
//   1. 斷言對象是**整包回應的字串**，不是逐欄比對 —— 逐欄比對正好漏掉「新欄位」這個真實風險。
//   2. 每條都同時斷言「端點真的有在工作」（有資料、有遮罩提示）—— 否則端點 500 或回空陣列
//      也會讓「秘密沒出現」通過，測試就變成擺設。
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { onRequestGet as relayChannelsGet } from "../../src/routes/api/admin/relay/channels/index.js";
import { onRequestPut as relayChannelPut } from "../../src/routes/api/admin/relay/channels/[id].js";
import { onRequestGet as vpnChannelsGet } from "../../src/routes/api/admin/vpn/channels/index.js";
import { onRequestPut as vpnChannelPut } from "../../src/routes/api/admin/vpn/channels/[id].js";
import { onRequestGet as adminSettingsGet } from "../../src/routes/api/admin/settings.js";
import { onRequestGet as memberChannelsGet } from "../../src/routes/api/relay/channels.js";
import { createSession } from "../../src/lib/auth.js";
import { makeCtx, drainWaits, seedUser, envWith, ORIGIN } from "../helpers.js";
import type { TestCtx } from "../helpers.js";

// 三個秘密各自帶「絕不該出現」的字樣，斷言失敗時一眼看得出漏的是哪一個。
const RELAY_KEY = "sk-upstream-MUSTNOTLEAK-relay";
const VPN_URL = "https://upstream.example.com/sub?token=MUSTNOTLEAK-vpn";
const TG_TOKEN = "123456:MUSTNOTLEAK-telegram";
const SECRETS = [RELAY_KEY, VPN_URL, TG_TOKEN, "MUSTNOTLEAK"];

const TOK = "admintok";
const E = () => envWith({ LOGS_TOKEN: TOK });
const AUTH = { authorization: "Bearer " + TOK };

let relayId = 0;
let vpnId = 0;

beforeEach(async () => {
  const now = new Date().toISOString();
  const r = await env.DB.prepare(
    "INSERT INTO relay_channels (slug,name,kind,base_url,api_key,models,enabled,created_at) " +
      "VALUES ('secret-ch','秘密渠道','openai','https://api.example.com',?1,'m1',1,?2)"
  )
    .bind(RELAY_KEY, now)
    .run();
  relayId = r.meta.last_row_id as number;
  const v = await env.DB.prepare(
    "INSERT INTO vpn_channels (name,kind,url,nodes,enabled,created_at) VALUES ('秘密機場','sub',?1,'',1,?2)"
  )
    .bind(VPN_URL, now)
    .run();
  vpnId = v.meta.last_row_id as number;
  await env.DB.prepare(
    "INSERT INTO settings (k,v) VALUES ('tg_bot_token',?1) ON CONFLICT(k) DO UPDATE SET v=excluded.v"
  )
    .bind(TG_TOKEN)
    .run();
});

// 整包回應序列化後不得含任何秘密字樣。
function expectNoSecrets(bodyText: string) {
  for (const s of SECRETS) expect(bodyText).not.toContain(s);
}

async function callJson(fn: (c: TestCtx) => Promise<Response>, ctx: TestCtx) {
  const r = await fn(ctx);
  await drainWaits(ctx);
  const text = await r.text();
  return { status: r.status, text: text, json: JSON.parse(text) };
}

describe("管理員回應不外洩上游秘密（README 頭號宣稱）", () => {
  it("GET /api/admin/relay/channels：有渠道、有遮罩提示，但整包不含上游金鑰", async () => {
    const ctx = makeCtx({ url: ORIGIN + "/api/admin/relay/channels", init: { headers: AUTH }, env: E() });
    const { status, text, json } = await callJson(relayChannelsGet, ctx);
    expect(status).toBe(200);
    // 端點真的有在工作（否則「沒有秘密」毫無意義）
    const row = json.rows.find((x: any) => x.id === relayId);
    expect(row).toBeTruthy();
    expect(row.has_key).toBe(true);
    expect(row.key_hint).toBeTruthy();
    expect(row.key_hint).not.toBe(RELAY_KEY); // 提示不能等於明文
    expectNoSecrets(text);
  });

  it("PUT /api/admin/relay/channels/:id：改別的欄位，回應仍不含上游金鑰", async () => {
    const ctx = makeCtx({
      url: ORIGIN + "/api/admin/relay/channels/" + relayId,
      init: {
        method: "PUT",
        headers: Object.assign({ "content-type": "application/json" }, AUTH),
        body: JSON.stringify({ name: "改個名字", base_url: "https://api.example.com", models: "m1" })
      },
      params: { id: String(relayId) },
      env: E()
    });
    const { status, text, json } = await callJson(relayChannelPut, ctx);
    expect(status).toBe(200);
    expect(json.row.name).toBe("改個名字");
    expect(json.row.has_key).toBe(true); // 沒帶 api_key＝保留舊值，確認金鑰還在
    expectNoSecrets(text);
  });

  it("GET /api/admin/vpn/channels：有機場、有遮罩提示，但整包不含上游訂閱網址", async () => {
    const ctx = makeCtx({ url: ORIGIN + "/api/admin/vpn/channels", init: { headers: AUTH }, env: E() });
    const { status, text, json } = await callJson(vpnChannelsGet, ctx);
    expect(status).toBe(200);
    const row = json.rows.find((x: any) => x.id === vpnId);
    expect(row).toBeTruthy();
    expect(row.has_url).toBe(true);
    expect(row.url_hint).toBeTruthy();
    expect(row.url_hint).not.toBe(VPN_URL);
    expectNoSecrets(text);
  });

  it("PUT /api/admin/vpn/channels/:id：改別的欄位，回應仍不含上游訂閱網址", async () => {
    const ctx = makeCtx({
      url: ORIGIN + "/api/admin/vpn/channels/" + vpnId,
      init: {
        method: "PUT",
        headers: Object.assign({ "content-type": "application/json" }, AUTH),
        body: JSON.stringify({ name: "改個名字", kind: "sub" })
      },
      params: { id: String(vpnId) },
      env: E()
    });
    const { status, text, json } = await callJson(vpnChannelPut, ctx);
    expect(status).toBe(200);
    expect(json.row.name).toBe("改個名字");
    expect(json.row.has_url).toBe(true);
    expectNoSecrets(text);
  });

  it("GET /api/admin/settings：Telegram bot token 只回 set/hint，不回明文", async () => {
    const ctx = makeCtx({ url: ORIGIN + "/api/admin/settings", init: { headers: AUTH }, env: E() });
    const { status, text, json } = await callJson(adminSettingsGet, ctx);
    expect(status).toBe(200);
    expect(json.tg_token_set).toBe(true);
    expect(json.tg_token_hint).toBeTruthy();
    expectNoSecrets(text);
  });

  it("GET /api/relay/channels（會員視角）：只看得到 slug/name/kind/models", async () => {
    const u = await seedUser({ status: "approved", services: "relay" });
    const s = await createSession(env, u, new URL(ORIGIN + "/")); // 這支認登入 cookie，不認 uak- 金鑰
    const ctx = makeCtx({
      url: ORIGIN + "/api/relay/channels",
      init: { headers: { cookie: "ipua_sess=" + s.sid } },
      env: E()
    });
    const { status, text, json } = await callJson(memberChannelsGet, ctx);
    expect(status).toBe(200);
    const row = (json.rows || json.channels || []).find((x: any) => x.slug === "secret-ch");
    expect(row).toBeTruthy();
    expect(row.base_url).toBeUndefined(); // 會員連上游位址都不該知道
    expect(row.has_key).toBeUndefined();
    expectNoSecrets(text);
  });
});
