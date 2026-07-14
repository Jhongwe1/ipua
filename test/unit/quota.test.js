// lib/quota.js — scanUsage（回應掃描）與 extractUsage（playground 累積）fixtures、
// checkQuota 的個人覆寫／全域設定／內建預設三層優先序。
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { scanUsage, checkQuota, logReq, QUOTA_DEFAULTS, utcDayStart } from "../../lib/quota.js";
import { extractUsage } from "../../lib/playground.js";
import { seedUser, seedAdmin } from "../helpers.js";

describe("scanUsage（relay 回應掃描：SSE 或 JSON 原文）", () => {
  it("OpenAI SSE：最後一筆 usage＋model", () => {
    const sse =
      'data: {"model":"gpt-x","choices":[{"delta":{"content":"a"}}]}\n\n' +
      'data: {"model":"gpt-x","choices":[],"usage":{"prompt_tokens":12,"completion_tokens":34}}\n\n' +
      "data: [DONE]\n\n";
    expect(scanUsage(sse)).toEqual({ model: "gpt-x", tokens_in: 12, tokens_out: 34 });
  });
  it("Anthropic SSE：message_start 的 input＋message_delta 尾端的 output（各取最後值）", () => {
    const sse =
      'data: {"type":"message_start","message":{"model":"claude-y","usage":{"input_tokens":55,"output_tokens":1}}}\n\n' +
      'data: {"type":"content_block_delta","delta":{"text":"hi"}}\n\n' +
      'data: {"type":"message_delta","usage":{"output_tokens":77}}\n\n';
    expect(scanUsage(sse)).toEqual({ model: "claude-y", tokens_in: 55, tokens_out: 77 });
  });
  it("Gemini：usageMetadata（promptTokenCount/candidatesTokenCount）", () => {
    const body = '{"candidates":[],"usageMetadata":{"promptTokenCount":9,"candidatesTokenCount":21},"modelVersion":"x"}';
    const u = scanUsage(body);
    expect(u.tokens_in).toBe(9);
    expect(u.tokens_out).toBe(21);
  });
  it("整包 JSON（非串流）也掃得到；掃不到＝null", () => {
    expect(scanUsage('{"model":"m1","usage":{"prompt_tokens":1,"completion_tokens":2}}'))
      .toEqual({ model: "m1", tokens_in: 1, tokens_out: 2 });
    expect(scanUsage("data: [DONE]\n\n")).toEqual({ model: "", tokens_in: null, tokens_out: null });
  });
});

describe("extractUsage（playground 逐筆累積）", () => {
  it("anthropic：message_start 進 input、message_delta 覆寫 output", () => {
    const acc = { tokens_in: null, tokens_out: null };
    extractUsage("anthropic", { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 1 } } }, acc);
    extractUsage("anthropic", { type: "message_delta", usage: { output_tokens: 42 } }, acc);
    expect(acc).toEqual({ tokens_in: 10, tokens_out: 42 });
  });
  it("gemini：usageMetadata 逐筆覆寫", () => {
    const acc = extractUsage("gemini", { usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 8 } });
    expect(acc).toEqual({ tokens_in: 5, tokens_out: 8 });
  });
  it("openai：最後一筆 usage；沒有 usage 的筆不動", () => {
    const acc = { tokens_in: null, tokens_out: null };
    extractUsage("openai", { choices: [{ delta: { content: "x" } }] }, acc);
    expect(acc).toEqual({ tokens_in: null, tokens_out: null });
    extractUsage("openai", { usage: { prompt_tokens: 3, completion_tokens: 4 } }, acc);
    expect(acc).toEqual({ tokens_in: 3, tokens_out: 4 });
  });
});

describe("checkQuota 三層優先序＋豁免", () => {
  it("站長永遠放行（就算個人配額是 0）", async () => {
    const adm = await seedAdmin({ quota_relay_day: 0, rl_per_min: 0 });
    expect((await checkQuota(env, adm, "relay")).ok).toBe(true);
  });
  it("個人覆寫優先於全域設定：個人 1、用掉 1 → 429 quota-exceeded＋Retry-After", async () => {
    await env.DB.prepare("INSERT INTO settings (k,v) VALUES ('quota_relay_day','999')").run();
    const u = await seedUser({ status: "approved", services: "relay", quota_relay_day: 1 });
    await logReq(env, { user_id: u.id, svc: "relay", status: 200 });
    // 滾動 60 秒的 rate limit 會先擋 — 拉高個人 rl 讓日配額先觸發
    await env.DB.prepare("UPDATE users SET rl_per_min=999 WHERE id=?1").bind(u.id).run();
    const fresh = await env.DB.prepare("SELECT * FROM users WHERE id=?1").bind(u.id).first();
    const q = await checkQuota(env, fresh, "relay");
    expect(q.ok).toBe(false);
    expect(q.resp.status).toBe(429);
    expect(q.resp.headers.get("retry-after")).toMatch(/^\d+$/);
    const j = await q.resp.json();
    expect(j.error).toBe("quota-exceeded");
    expect(j.used).toBe(1);
    expect(j.limit).toBe(1);
    expect(j.reset).toContain("T00:00:00");
  });
  it("滾動 60 秒 rate limit：個人 rl_per_min=1、剛用 1 次 → 429 rate-limited", async () => {
    const u = await seedUser({ status: "approved", services: "relay", rl_per_min: 1 });
    await logReq(env, { user_id: u.id, svc: "relay", status: 200 });
    const fresh = await env.DB.prepare("SELECT * FROM users WHERE id=?1").bind(u.id).first();
    const q = await checkQuota(env, fresh, "relay");
    expect(q.ok).toBe(false);
    const j = await q.resp.json();
    expect(j.error).toBe("rate-limited");
    expect(q.resp.headers.get("retry-after")).toBe("60");
  });
  it("沒設定就用內建預設（用量 0 → 放行）；兩服務日窗分開算", async () => {
    const u = await seedUser({ status: "approved", services: "relay,playground" });
    await logReq(env, { user_id: u.id, svc: "pg", status: 200 });
    expect((await checkQuota(env, u, "relay")).ok).toBe(true);   // pg 的量不吃 relay 日配額
    expect(QUOTA_DEFAULTS.quota_relay_day).toBe(500);
  });
  it("utcDayStart 是今天 UTC 0 點", () => {
    expect(utcDayStart()).toBe(new Date().toISOString().slice(0, 10) + "T00:00:00.000Z");
  });
});
