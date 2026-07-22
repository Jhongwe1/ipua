// Dumb mode（v2.2）＋ VPN 對外展示（vpn_public）— 伺服器端強制與遮罩。
// Dumb mode 的合約：開啟＋指定渠道×模型後，非管理員會員
//   1. /api/playground/models 只拿到 { rows:[], dumb:true }（看不到任何模型）
//   2. /api/playground/chat 不管帶什麼 channel/model 都被蓋成指定值（devtools 硬塞也沒用）
//   3. 對話列表與內頁的 channel/model 一律遮空
// 管理員完全不受限。vpn_public：開＝/api/menu 對匿名者也回 VPN 項；關＝隱形（v2.2 起
// /api/menu 也過濾 — 以前這支不濾，/ip 靜態頁的側欄會對匿名者洩漏 VPN）。
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { env, fetchMock } from "cloudflare:test";
import { onRequestPut as settingsPut } from "../../src/routes/api/admin/settings.js";
import { onRequestGet as modelsGet } from "../../src/routes/api/playground/models.js";
import { onRequestGet as convListGet } from "../../src/routes/api/playground/conversations/index.js";
import { onRequestGet as convGet } from "../../src/routes/api/playground/conversations/[id].js";
import { onRequestPost as chatPost } from "../../src/routes/api/playground/chat.js";
import { onRequestGet as menuGet } from "../../src/routes/api/menu.js";
import { createSession } from "../../src/lib/auth.js";
import {
  makeCtx,
  drainWaits,
  envWith,
  seedUser,
  seedAdmin,
  seedChannel,
  readAll,
  ORIGIN
} from "../helpers.js";
import type { TestCtx } from "../helpers.js";
import type { UserRow } from "../../src/types.js";

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

const TOK = "admintok";
const setKey = (k: string, v: string) =>
  env.DB.prepare("INSERT INTO settings (k,v) VALUES (?1,?2) ON CONFLICT(k) DO UPDATE SET v=excluded.v")
    .bind(k, v)
    .run();
const dumbOn = async (channel: string, model: string) => {
  await setKey("dumb_mode", "1");
  await setKey("dumb_channel", channel);
  await setKey("dumb_model", model);
};

async function userCtx(user: UserRow, url: string, init?: RequestInit): Promise<TestCtx> {
  const sess = await createSession(env, user, new URL(ORIGIN + "/"));
  const headers = Object.assign(
    { cookie: "ipua_sess=" + sess.sid, origin: ORIGIN },
    (init && init.headers) || {}
  );
  return makeCtx({ url: url, init: Object.assign({}, init, { headers }) });
}

describe("dumb mode 設定（/api/admin/settings）", () => {
  const putCtx = (body: unknown) =>
    makeCtx({
      url: ORIGIN + "/api/admin/settings",
      init: {
        method: "PUT",
        headers: { authorization: "Bearer " + TOK, "content-type": "application/json" },
        body: JSON.stringify(body)
      },
      env: envWith({ LOGS_TOKEN: TOK })
    });

  it("dumb 三鍵存取與 dumb_active（開關＋渠道＋模型齊全才生效）", async () => {
    let ctx = putCtx({ dumb_mode: true });
    let j: any = await (await settingsPut(ctx)).json();
    await drainWaits(ctx);
    expect(j.dumb_mode).toBe(true);
    expect(j.dumb_active).toBe(false); // 還沒指定模型

    ctx = putCtx({ dumb_channel: "ch1", dumb_model: "Model-X" });
    j = await (await settingsPut(ctx)).json();
    await drainWaits(ctx);
    expect(j.dumb_active).toBe(true);
    expect(j.dumb_channel).toBe("ch1");
    expect(j.dumb_model).toBe("Model-X"); // 模型名不轉小寫

    ctx = putCtx({ dumb_channel: "", dumb_model: "" });
    j = await (await settingsPut(ctx)).json();
    await drainWaits(ctx);
    expect(j.dumb_active).toBe(false);
    expect(await env.DB.prepare("SELECT v FROM settings WHERE k='dumb_channel'").first()).toBeNull();
  });

  it("vpn_public：true 存 '1'、false 刪鍵", async () => {
    let ctx = putCtx({ vpn_public: true });
    let j: any = await (await settingsPut(ctx)).json();
    await drainWaits(ctx);
    expect(j.vpn_public).toBe(true);
    ctx = putCtx({ vpn_public: false });
    j = await (await settingsPut(ctx)).json();
    await drainWaits(ctx);
    expect(j.vpn_public).toBe(false);
    expect(await env.DB.prepare("SELECT v FROM settings WHERE k='vpn_public'").first()).toBeNull();
  });
});

describe("dumb mode 生效時的 API 行為", () => {
  it("models：會員只拿到 rows:[]＋dumb:true；管理員照常拿完整清單", async () => {
    const ch = await seedChannel({ models: "m1,m2" });
    await dumbOn(ch.slug, "m1");
    const member = await seedUser({ status: "approved", services: "playground" });
    const j: any = await (await modelsGet(await userCtx(member, ORIGIN + "/api/playground/models"))).json();
    expect(j.dumb).toBe(true);
    expect(j.rows).toEqual([]);

    await seedAdmin();
    const adm: any = await (
      await modelsGet(
        makeCtx({
          url: ORIGIN + "/api/playground/models",
          init: { headers: { authorization: "Bearer " + TOK } },
          env: envWith({ LOGS_TOKEN: TOK })
        })
      )
    ).json();
    expect(adm.dumb).toBeUndefined();
    expect(adm.rows.length).toBeGreaterThan(0);
  });

  it("chat：會員亂帶 channel/model 也會被鎖到指定模型（以對話落地為證）", async () => {
    // decoy＝會員以為自己在用的渠道；locked＝管理員指定的 — 只有 locked 的上游被攔截器接住
    await seedChannel({ slug: "decoy", base_url: "https://decoy.example.com", models: "free-model" });
    const locked = await seedChannel({
      slug: "locked",
      base_url: "https://locked.example.com",
      models: "secret-model"
    });
    await dumbOn(locked.slug, "secret-model");
    fetchMock
      .get("https://locked.example.com")
      .intercept({ path: "/v1/chat/completions", method: "POST" })
      .reply(200, 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
        headers: { "content-type": "text/event-stream" }
      });

    const member = await seedUser({ status: "approved", services: "playground" });
    const ctx = await userCtx(member, ORIGIN + "/api/playground/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        channel: "decoy",
        model: "free-model",
        messages: [{ role: "user", content: "hi" }]
      })
    });
    const resp = await chatPost(ctx);
    expect(resp.status).toBe(200);
    await readAll(resp);
    await drainWaits(ctx);
    const conv: any = await env.DB.prepare("SELECT channel,model FROM pg_conversations WHERE user_id=?1")
      .bind(member.id)
      .first();
    expect(conv.channel).toBe("locked");
    expect(conv.model).toBe("secret-model");
  });

  it("對話列表與內頁：會員看不到 channel/model；管理員看得到", async () => {
    const ch = await seedChannel({ models: "m1" });
    await dumbOn(ch.slug, "m1");
    const member = await seedUser({ status: "approved", services: "playground" });
    const now = new Date().toISOString();
    const r = await env.DB.prepare(
      "INSERT INTO pg_conversations (user_id,title,channel,model,created_at,updated_at) VALUES (?1,'t',?2,'m1',?3,?3)"
    )
      .bind(member.id, ch.slug, now)
      .run();
    const cid = r.meta.last_row_id;
    await env.DB.prepare(
      "INSERT INTO pg_messages (conv_id,role,content,model,created_at) VALUES (?1,'assistant','hi','m1',?2)"
    )
      .bind(cid, now)
      .run();

    const list: any = await (
      await convListGet(await userCtx(member, ORIGIN + "/api/playground/conversations"))
    ).json();
    expect(list.rows[0].channel).toBe("");
    expect(list.rows[0].model).toBe("");

    const detailCtx = await userCtx(member, ORIGIN + "/api/playground/conversations/" + cid);
    detailCtx.params = { id: String(cid) };
    const detail: any = await (await convGet(detailCtx)).json();
    expect(detail.conv.channel).toBe("");
    expect(detail.conv.model).toBe("");
    expect(detail.messages[0].model).toBe("");
    expect(JSON.stringify(detail)).not.toContain("m1");
  });
});

describe("/api/menu 的 VPN 過濾（v2.2）", () => {
  it("匿名：預設看不到 /vpn；vpn_public 開了才看得到", async () => {
    let j: any = await (await menuGet(makeCtx({ url: ORIGIN + "/api/menu" }))).json();
    expect(j.items.some((it: any) => it.url === "/vpn")).toBe(false);
    await setKey("vpn_public", "1");
    j = await (await menuGet(makeCtx({ url: ORIGIN + "/api/menu" }))).json();
    expect(j.items.some((it: any) => it.url === "/vpn")).toBe(true);
  });

  it("管理金鑰（選單編輯器）永遠拿未過濾清單", async () => {
    const j: any = await (
      await menuGet(
        makeCtx({
          url: ORIGIN + "/api/menu",
          init: { headers: { authorization: "Bearer " + TOK } },
          env: envWith({ LOGS_TOKEN: TOK })
        })
      )
    ).json();
    expect(j.items.some((it: any) => it.url === "/vpn")).toBe(true);
  });
});
