// 冒煙測試 — 驗證整條測試工具鏈成立：
//   1. bracket 檔名（functions/relay/[[path]].js）可以直接 import（整個測試策略的前提）
//   2. migrations 已套用（D1 有表）、helpers 的 makeCtx 能驅動 handler
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { onRequest } from "../../functions/relay/[[path]].js";
import { makeCtx, ORIGIN } from "../helpers.js";

describe("工具鏈冒煙", () => {
  it("bracket 檔名 handler 可直接 import 且能執行（無金鑰 → 401）", async () => {
    const ctx = makeCtx({
      url: ORIGIN + "/relay/openai/v1/models",
      params: { path: ["openai", "v1", "models"] }
    });
    const resp = await onRequest(ctx);
    expect(resp.status).toBe(401);
    const j = await resp.json();
    expect(j.error).toBe("no-key");
  });

  it("migrations 已套用：核心表都在", async () => {
    const r = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all();
    const names = (r.results || []).map((x) => x.name);
    for (const t of ["visits", "articles", "users", "sessions", "relay_channels", "vpn_channels", "pg_conversations", "settings"]) {
      expect(names).toContain(t);
    }
  });
});
