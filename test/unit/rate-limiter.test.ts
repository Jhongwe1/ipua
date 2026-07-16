// src/do/rate-limiter.ts — DO 限流器單測（滑動窗數學、UTC 懶重置、併發原子性）
// ＋ checkQuota 三層降級整合測試（DO → D1 COUNT → 放行；ADR-0007）。
// 時間相關的斷言用 check() 的 now 注入參數（測試專用時鐘），不碰 fake timers —
// DO 在另一個執行 context，vi.useFakeTimers 蓋不到它的 Date.now。
import { describe, it, expect } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { checkQuota, logReq } from "../../src/lib/quota.js";
import { RateLimiter } from "../../src/do/rate-limiter.js";
import { seedUser, envWith } from "../helpers.js";
import type { Env } from "../../src/types.js";

// 每個測試自己拿一顆全新 DO（isolatedStorage 之外再加名字隔離，斷言互不污染）
function freshStub() {
  const ns = env.RATE_LIMITER!;
  return ns.get(ns.idFromName("test:" + Math.random().toString(36).slice(2)));
}

// 對齊分鐘邊界的固定測試時鐘（UTC 2026-07-17 12:00:00.000）
const T0 = Date.UTC(2026, 6, 17, 12, 0, 0);

describe("RateLimiter DO：兩桶加權滑動窗", () => {
  it("同一分鐘內：恰好 perMin 個過、下一個被擋（used/limit 如實回報）", async () => {
    const stub = freshStub();
    for (let i = 0; i < 10; i++) {
      expect((await stub.check({ svc: "relay", perMin: 10, perDay: 1000, now: T0 + i })).ok).toBe(true);
    }
    const r = await stub.check({ svc: "relay", perMin: 10, perDay: 1000, now: T0 + 50 });
    expect(r).toEqual({ ok: false, kind: "min", used: 10, limit: 10 });
  });
  it("跨分鐘：上一桶按窗內剩餘比例加權（60 秒整＝全額擋；90 秒＝半額，再過 5 個才擋）", async () => {
    const stub = freshStub();
    for (let i = 0; i < 10; i++) await stub.check({ svc: "relay", perMin: 10, perDay: 1000, now: T0 });
    // T0+60s：新分鐘的 0 秒，上一桶權重 1 → 估計 10 ≥ 10 → 擋
    expect((await stub.check({ svc: "relay", perMin: 10, perDay: 1000, now: T0 + 60e3 })).ok).toBe(false);
    // T0+90s：權重 0.5 → 估計 5，還能再過 5 個；第 6 個（估計 0.5×10+5=10）被擋
    for (let i = 0; i < 5; i++) {
      expect((await stub.check({ svc: "relay", perMin: 10, perDay: 1000, now: T0 + 90e3 })).ok).toBe(true);
    }
    const r = await stub.check({ svc: "relay", perMin: 10, perDay: 1000, now: T0 + 90e3 });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.kind).toBe("min");
  });
  it("分鐘窗跨服務共用（對齊 v1 的 60 秒窗不分 svc）", async () => {
    const stub = freshStub();
    expect((await stub.check({ svc: "relay", perMin: 1, perDay: 100, now: T0 })).ok).toBe(true);
    const r = await stub.check({ svc: "pg", perMin: 1, perDay: 100, now: T0 + 1 });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.kind).toBe("min");
  });
  it("perMin=0 直接擋（跟 D1 路徑的 0 ≥ 0 語意一致）", async () => {
    const stub = freshStub();
    expect((await stub.check({ svc: "relay", perMin: 0, perDay: 100, now: T0 })).ok).toBe(false);
  });
});

describe("RateLimiter DO：日配額（UTC 日鍵懶重置）", () => {
  it("當日恰好 perDay 個過；日窗分服務、互不相吃", async () => {
    const stub = freshStub();
    for (let i = 0; i < 3; i++) {
      expect((await stub.check({ svc: "relay", perMin: 999, perDay: 3, now: T0 + i })).ok).toBe(true);
    }
    const r = await stub.check({ svc: "relay", perMin: 999, perDay: 3, now: T0 + 10 });
    expect(r).toEqual({ ok: false, kind: "day", used: 3, limit: 3 });
    // pg 的日鍵是另一把，不受 relay 用滿影響
    expect((await stub.check({ svc: "pg", perMin: 999, perDay: 3, now: T0 + 20 })).ok).toBe(true);
  });
  it("隔天（UTC）自動歸零，且舊日鍵被順手清掉", async () => {
    const stub = freshStub();
    for (let i = 0; i < 2; i++) await stub.check({ svc: "relay", perMin: 999, perDay: 2, now: T0 });
    expect((await stub.check({ svc: "relay", perMin: 999, perDay: 2, now: T0 })).ok).toBe(false);
    // +24h：鍵名換日 → 讀不到舊計數 → 放行；放行順手清掉 07-17 的舊鍵
    const nextDay = T0 + 86400e3;
    expect((await stub.check({ svc: "relay", perMin: 999, perDay: 2, now: nextDay })).ok).toBe(true);
    await runInDurableObject(stub, (instance: RateLimiter, state) => {
      const keys = state.storage.sql
        .exec<{ k: string }>("SELECT k FROM counters WHERE k LIKE 'd:%'")
        .toArray()
        .map((r) => r.k);
      expect(keys).toEqual(["d:2026-07-18:relay"]);
      expect(instance).toBeInstanceOf(RateLimiter);
    });
  });
});

describe("RateLimiter DO：原子性（換 DO 的核心理由）", () => {
  it("Promise.all 併發 30 發、perMin=10 → 恰好 10 個過（D1 COUNT 路徑做不到這件事）", async () => {
    const stub = freshStub();
    const rs = await Promise.all(
      Array.from({ length: 30 }, () => stub.check({ svc: "relay", perMin: 10, perDay: 1000, now: T0 }))
    );
    expect(rs.filter((r) => r.ok).length).toBe(10);
  });
});

describe("checkQuota 三層降級（DO → D1 COUNT → 放行）", () => {
  it("第一層 DO：連打超過 rl_per_min 被 429 — req_log 全空，證明擋人的是 DO 不是 D1", async () => {
    const u = await seedUser({ status: "approved", services: "relay", rl_per_min: 2 });
    expect((await checkQuota(env, u, "relay")).ok).toBe(true);
    expect((await checkQuota(env, u, "relay")).ok).toBe(true);
    const q = await checkQuota(env, u, "relay");
    expect(q.ok).toBe(false);
    expect(q.resp!.status).toBe(429);
    const j: any = await q.resp!.json();
    expect(j.error).toBe("rate-limited");
    expect(j.limit).toBe(2);
  });
  it("第一層 DO：日配額 429 的回應形狀與 v1 相同（reset＝UTC 午夜、Retry-After 秒數）", async () => {
    const u = await seedUser({ status: "approved", services: "relay", quota_relay_day: 1, rl_per_min: 999 });
    expect((await checkQuota(env, u, "relay")).ok).toBe(true);
    const q = await checkQuota(env, u, "relay");
    expect(q.ok).toBe(false);
    expect(q.resp!.status).toBe(429);
    expect(q.resp!.headers.get("retry-after")).toMatch(/^\d+$/);
    const j: any = await q.resp!.json();
    expect(j.error).toBe("quota-exceeded");
    expect(j.used).toBe(1);
    expect(j.limit).toBe(1);
    expect(j.reset).toContain("T00:00:00");
  });
  it("settings quota_do='0' ＝一鍵退回 D1 路徑：req_log 沒列 → 連打也放行", async () => {
    await env.DB.prepare("INSERT INTO settings (k,v) VALUES ('quota_do','0')").run();
    const u = await seedUser({ status: "approved", services: "relay", rl_per_min: 1 });
    expect((await checkQuota(env, u, "relay")).ok).toBe(true);
    expect((await checkQuota(env, u, "relay")).ok).toBe(true); // DO 路徑的話第 2 發就被擋了
  });
  it("第二層：DO 故障 → 退 D1 COUNT 照樣擋人，並在 errlog 留 quota.do 一筆", async () => {
    const broken = envWith({
      RATE_LIMITER: {
        idFromName() {
          throw new Error("DO down");
        }
      }
    }) as Env;
    const u = await seedUser({ status: "approved", services: "relay", rl_per_min: 1 });
    await logReq(env, { user_id: u.id, svc: "relay", status: 200 });
    const q = await checkQuota(broken, u, "relay");
    expect(q.ok).toBe(false);
    const j: any = await q.resp!.json();
    expect(j.error).toBe("rate-limited");
    const err = await env.DB.prepare("SELECT src FROM errlog WHERE src='quota.do'").first<{ src: string }>();
    expect(err?.src).toBe("quota.do");
  });
  it("第三層：連 D1 都壞 → 放行（配額永不弄掛服務）", async () => {
    const u = await seedUser({ status: "approved", services: "relay", rl_per_min: 0, quota_relay_day: 0 });
    const dead = envWith({
      DB: {
        prepare() {
          throw new Error("D1 down");
        }
      }
    }) as Env;
    expect((await checkQuota(dead, u, "relay")).ok).toBe(true);
  });
});
