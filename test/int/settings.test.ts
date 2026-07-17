// /api/admin/settings — PUT「帶哪個鍵就改哪個鍵」語意（沒帶的絕不動）＋
// GET 原況（2026-07-17 /settings 管理頁的數據源：沒設的數字鍵回 null、附 defaults）。
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { onRequestPut as rawPut, onRequestGet } from "../../src/routes/api/admin/settings.js";
import { makeCtx, drainWaits, envWith, ORIGIN } from "../helpers.js";
import type { TestCtx } from "../helpers.js";

// settings PUT 會掛 audit 背景寫入 — 包一層自動排水
const onRequestPut = async (ctx: TestCtx) => {
  const r = await rawPut(ctx);
  await drainWaits(ctx);
  return r;
};

const TOK = "admintok";
function ctx(body: unknown) {
  return makeCtx({
    url: ORIGIN + "/api/admin/settings",
    init: {
      method: "PUT",
      headers: { authorization: "Bearer " + TOK, "content-type": "application/json" },
      body: JSON.stringify(body)
    },
    env: envWith({ LOGS_TOKEN: TOK })
  });
}
const getKey = (k: string) => env.DB.prepare("SELECT v FROM settings WHERE k=?1").bind(k).first<any>();

describe("settings 帶哪鍵改哪鍵", () => {
  it("只帶 brand：改站名、pg_open 不動", async () => {
    await env.DB.prepare("INSERT INTO settings (k,v) VALUES ('pg_open','1')").run();
    const r = await onRequestPut(ctx({ brand: "新站名" }));
    expect(r.status).toBe(200);
    const j: any = await r.json();
    expect(j.brand).toBe("新站名");
    expect(j.pg_open).toBe(true); // 沒帶的鍵原封不動
    expect((await getKey("brand")).v).toBe("新站名");
  });

  it("只帶 pg_open：brand 不動", async () => {
    await env.DB.prepare("INSERT INTO settings (k,v) VALUES ('brand','舊站名')").run();
    const r = await onRequestPut(ctx({ pg_open: true }));
    const j: any = await r.json();
    expect(j.pg_open).toBe(true);
    expect(j.brand).toBe("舊站名");
    expect((await getKey("pg_open")).v).toBe("1");
  });

  it("brand 空字串＝刪鍵＝還原預設", async () => {
    await env.DB.prepare("INSERT INTO settings (k,v) VALUES ('brand','自訂')").run();
    const j: any = await (await onRequestPut(ctx({ brand: "" }))).json();
    expect(j.custom).toBe(false);
    expect(await getKey("brand")).toBeNull();
  });

  it("pg_open false＝刪鍵＝回到逐人批准", async () => {
    await env.DB.prepare("INSERT INTO settings (k,v) VALUES ('pg_open','1')").run();
    const j: any = await (await onRequestPut(ctx({ pg_open: false }))).json();
    expect(j.pg_open).toBe(false);
    expect(await getKey("pg_open")).toBeNull();
  });

  it("配額全域鍵：正整數存入、null 刪鍵回內建預設、壞值 400", async () => {
    let j: any = await (await onRequestPut(ctx({ quota_relay_day: 100, rl_per_min: 5 }))).json();
    expect(j.quota_relay_day).toBe(100);
    expect(j.rl_per_min).toBe(5);
    expect(j.quota_pg_day).toBe(200); // 沒帶＝內建預設
    expect((await getKey("quota_relay_day")).v).toBe("100");
    j = await (await onRequestPut(ctx({ quota_relay_day: null }))).json();
    expect(j.quota_relay_day).toBe(500); // 刪鍵回內建
    expect(await getKey("quota_relay_day")).toBeNull();
    expect((await onRequestPut(ctx({ quota_pg_day: 0 }))).status).toBe(400); // 全域不收 0（會鎖死大家）
    expect((await onRequestPut(ctx({ rl_per_min: "abc" }))).status).toBe(400);
  });

  it("contact_url：http(s) 網址存入、空字串刪鍵、非 http(s) 400", async () => {
    let j: any = await (await onRequestPut(ctx({ contact_url: "https://example.com/me" }))).json();
    expect(j.contact_url).toBe("https://example.com/me");
    expect((await getKey("contact_url")).v).toBe("https://example.com/me");
    expect((await onRequestPut(ctx({ contact_url: "javascript:alert(1)" }))).status).toBe(400);
    j = await (await onRequestPut(ctx({ contact_url: "" }))).json();
    expect(j.contact_url).toBe("");
    expect(await getKey("contact_url")).toBeNull();
  });

  it("relay_meter：false 存 '0'（退回純直通）、true 刪鍵（預設開）", async () => {
    let j: any = await (await onRequestPut(ctx({ relay_meter: false }))).json();
    expect(j.relay_meter).toBe(false);
    expect((await getKey("relay_meter")).v).toBe("0");
    j = await (await onRequestPut(ctx({ relay_meter: true }))).json();
    expect(j.relay_meter).toBe(true);
    expect(await getKey("relay_meter")).toBeNull();
  });

  it("GET：沒設過＝null＋defaults；設過＝原值；demo_active 要開關＋渠道都齊", async () => {
    const getCtx = (auth?: boolean) =>
      makeCtx({
        url: ORIGIN + "/api/admin/settings",
        init: { headers: auth === false ? {} : { authorization: "Bearer " + TOK } },
        env: envWith({ LOGS_TOKEN: TOK })
      });
    let j: any = await (await onRequestGet(getCtx())).json();
    expect(j.ok).toBe(true);
    expect(j.custom).toBe(false);
    expect(j.quota_relay_day).toBeNull(); // 沒設＝null（不是內建預設值）
    expect(j.demo_per_min).toBeNull();
    expect(j.defaults.quota_relay_day).toBe(500);
    expect(j.defaults.demo_per_min).toBe(3);
    expect(j.demo_mode).toBe(false);
    expect(j.demo_active).toBe(false);

    // 設幾個鍵再讀：原值照回；demo 只開開關（沒渠道）＝ mode true 但 active false
    await onRequestPut(ctx({ brand: "站名A", quota_relay_day: 42, demo_mode: true }));
    j = await (await onRequestGet(getCtx())).json();
    expect(j.brand).toBe("站名A");
    expect(j.custom).toBe(true);
    expect(j.quota_relay_day).toBe(42);
    expect(j.demo_mode).toBe(true);
    expect(j.demo_active).toBe(false);
    await onRequestPut(ctx({ demo_channel: "demo-ch" }));
    j = await (await onRequestGet(getCtx())).json();
    expect(j.demo_active).toBe(true);
    expect(j.demo_channel).toBe("demo-ch");

    expect((await onRequestGet(getCtx(false))).status).toBe(401); // 沒授權 → 401
  });

  it("Telegram：存入後回讀遮罩（絕不回明文）、audit 不落 token、空字串清除", async () => {
    const SECRET = "123456:AAA-secret-token-xyz9";
    const r = await onRequestPut(ctx({ tg_bot_token: SECRET, tg_chat_id: "424242" }));
    expect(r.status).toBe(200);
    const putBody = await r.text();
    expect(putBody).not.toContain(SECRET); // PUT 回應也不能有明文
    const j: any = JSON.parse(putBody);
    expect(j.tg_token_set).toBe(true);
    expect(j.tg_token_hint).toBe("…xyz9");
    expect(j.tg_chat_id).toBe("424242");
    expect(j.tg_active).toBe(true);
    expect((await getKey("tg_bot_token")).v).toBe(SECRET); // DB 存原文（cron 要用）

    // audit_log 只記 (updated)，不落明文
    const audits = await env.DB.prepare(
      "SELECT summary FROM audit_log ORDER BY id DESC LIMIT 1"
    ).first<any>();
    expect(audits.summary).toContain("tg_bot_token=(updated)");
    expect(audits.summary).not.toContain(SECRET);

    // GET 同樣遮罩
    const getCtx = makeCtx({
      url: ORIGIN + "/api/admin/settings",
      init: { headers: { authorization: "Bearer " + TOK } },
      env: envWith({ LOGS_TOKEN: TOK })
    });
    const gBody = await (await onRequestGet(getCtx)).text();
    expect(gBody).not.toContain(SECRET);
    const g: any = JSON.parse(gBody);
    expect(g.tg_token_set).toBe(true);
    expect(g.tg_token_hint).toBe("…xyz9");
    expect(g.tg_active).toBe(true);

    // 空字串＝清除
    const j2: any = await (await onRequestPut(ctx({ tg_bot_token: "", tg_chat_id: "" }))).json();
    expect(j2.tg_token_set).toBe(false);
    expect(j2.tg_active).toBe(false);
    expect(await getKey("tg_bot_token")).toBeNull();
    expect(await getKey("tg_chat_id")).toBeNull();
  });

  it("站名截斷 60 字；一個鍵都沒帶 → 400；沒授權 → 401", async () => {
    const j: any = await (await onRequestPut(ctx({ brand: "x".repeat(100) }))).json();
    expect(j.brand.length).toBe(60);
    expect((await onRequestPut(ctx({}))).status).toBe(400);
    const anon = makeCtx({
      url: ORIGIN + "/api/admin/settings",
      init: { method: "PUT", headers: { "content-type": "application/json" }, body: "{}" },
      env: envWith({ LOGS_TOKEN: TOK })
    });
    expect((await onRequestPut(anon)).status).toBe(401);
  });
});
