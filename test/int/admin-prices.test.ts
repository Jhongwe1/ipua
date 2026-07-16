// /api/admin/prices（v2.0.0 Phase J）：授權、整包覆蓋語意、驗證、audit；
// 以及 stats 的成本整合（cost/by_user/unpriced_models）。
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { onRequestGet as pricesGet, onRequestPut as pricesPut } from "../../src/routes/api/admin/prices.js";
import { onRequestGet as statsGet } from "../../src/routes/api/admin/stats.js";
import { makeCtx, drainWaits, seedUser, envWith, ORIGIN } from "../helpers.js";

const TOK = "admintok";
const AUTH = { authorization: "Bearer " + TOK };
const E = () => envWith({ LOGS_TOKEN: TOK });

const putCtx = (body: unknown) =>
  makeCtx({
    url: ORIGIN + "/api/admin/prices",
    init: { method: "PUT", headers: Object.assign({ "content-type": "application/json" }, AUTH), body: JSON.stringify(body) },
    env: E()
  });

describe("/api/admin/prices", () => {
  it("沒授權 401（GET 與 PUT）", async () => {
    expect((await pricesGet(makeCtx({ url: ORIGIN + "/api/admin/prices", env: E() }))).status).toBe(401);
    expect(
      (
        await pricesPut(
          makeCtx({
            url: ORIGIN + "/api/admin/prices",
            init: { method: "PUT", body: "{}" },
            env: E()
          })
        )
      ).status
    ).toBe(401);
  });

  it("PUT 整包覆蓋 → GET 讀回；再 PUT 空陣列＝清空；寫 audit", async () => {
    const ctx = putCtx({
      items: [
        { pattern: "gpt-4o*", input_usd_per_m: 2.5, output_usd_per_m: 10, note: "官網 2026-07" },
        { pattern: "claude-sonnet-5", input_usd_per_m: 3, output_usd_per_m: 15 }
      ]
    });
    const r = await pricesPut(ctx);
    expect(r.status).toBe(200);
    await drainWaits(ctx);
    const g: any = await (await pricesGet(makeCtx({ url: ORIGIN + "/api/admin/prices", init: { headers: AUTH }, env: E() }))).json();
    expect(g.items.length).toBe(2);
    expect(g.items[0].pattern).toBe("claude-sonnet-5"); // 依 pattern 排序
    expect(g.items[1].input_usd_per_m).toBe(2.5);
    const audits = (await env.DB.prepare("SELECT action FROM audit_log").all()).results as any[];
    expect(audits.map((a) => a.action)).toContain("prices.put");

    const r2 = await pricesPut(putCtx({ items: [] }));
    expect(((await r2.json()) as any).count).toBe(0);
    const g2: any = await (await pricesGet(makeCtx({ url: ORIGIN + "/api/admin/prices", init: { headers: AUTH }, env: E() }))).json();
    expect(g2.items.length).toBe(0);
  });

  it("驗證：缺 items、pattern 重複、負數單價 → 400", async () => {
    expect((await pricesPut(putCtx({}))).status).toBe(400);
    expect(
      (
        await pricesPut(
          putCtx({ items: [{ pattern: "a", input_usd_per_m: 1, output_usd_per_m: 1 }, { pattern: "a", input_usd_per_m: 2, output_usd_per_m: 2 }] })
        )
      ).status
    ).toBe(400);
    expect((await pricesPut(putCtx({ items: [{ pattern: "a", input_usd_per_m: -1, output_usd_per_m: 0 }] }))).status).toBe(400);
  });
});

describe("stats 成本整合", () => {
  it("by_channel 帶 cost、by_user 每人彙總、未定價模型被點名、cost_total 只加有定價的", async () => {
    const u1 = await seedUser({ name: "甲", email: "a@example.com" });
    const u2 = await seedUser({ name: "乙", email: "b@example.com" });
    const now = new Date().toISOString();
    const ins = (uid: number, model: string, tin: number, tout: number) =>
      env.DB.prepare(
        "INSERT INTO req_log (ts,user_id,svc,channel,model,status,dur_ms,tokens_in,tokens_out) VALUES (?1,?2,'relay','ch',?3,200,50,?4,?5)"
      )
        .bind(now, uid, model, tin, tout)
        .run();
    await ins(u1.id, "gpt-4o-2024", 1_000_000, 0); // gpt-4o* → in $2.5
    await ins(u1.id, "gpt-4o-2024", 0, 1_000_000); // gpt-4o* → out $10
    await ins(u2.id, "mystery-model", 500, 500); // 未定價
    const pc = putCtx({ items: [{ pattern: "gpt-4o*", input_usd_per_m: 2.5, output_usd_per_m: 10 }] });
    await pricesPut(pc);
    await drainWaits(pc);

    const s: any = await (
      await statsGet(makeCtx({ url: ORIGIN + "/api/admin/stats?days=7", init: { headers: AUTH }, env: E() }))
    ).json();
    const priced = s.by_channel.find((r: any) => r.model === "gpt-4o-2024");
    expect(priced.cost).toBeCloseTo(12.5, 6);
    const unpriced = s.by_channel.find((r: any) => r.model === "mystery-model");
    expect(unpriced.cost).toBeNull();
    expect(s.unpriced_models).toEqual(["mystery-model"]);
    expect(s.cost_total).toBeCloseTo(12.5, 6);

    const bu1 = s.by_user.find((r: any) => r.user_id === u1.id);
    expect(bu1.email).toBe("a@example.com");
    expect(bu1.n).toBe(2);
    expect(bu1.cost).toBeCloseTo(12.5, 6);
    expect(bu1.unpriced).toBe(false);
    const bu2 = s.by_user.find((r: any) => r.user_id === u2.id);
    expect(bu2.cost).toBeNull();
    expect(bu2.unpriced).toBe(true);
  });
});
