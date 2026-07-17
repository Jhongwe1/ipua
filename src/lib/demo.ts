// src/lib/demo.ts — Demo 體驗模式（v2.0.0 Phase K，ADR-0009）。
// 讓「完全沒登入」的訪客在 /playground 直接試聊：鎖定管理員指定的渠道與模型白名單、
// 輸入 4k 字上限、強制低 max_tokens、對話**不落 D1**（只活在訪客瀏覽器）。
//
// 限流哲學與會員路徑「刻意相反」（ADR-0009 記載這個不對稱）：
//   會員配額 fail-open（配額系統壞了照樣放行 — 服務優先）；
//   demo 配額 **fail-closed**（DO 壞了直接 503 — 匿名流量寧可不服務，也不給人白嫖燒錢）。
// 雙保險：每 IP 一顆 DO（demo-ip:<ip>，分鐘＋日）＋全站一顆（demo:global，日）。
// 最壞燒錢上限＝demo_global_day × demo_max_tokens。
import { json } from "./site.js";
import { reportErrorNow } from "./observe.js";
import type { Env, UserRow } from "../types.js";

export const DEMO_DEFAULTS = {
  demo_per_min: 3, // 每 IP 每分鐘
  demo_per_ip_day: 10, // 每 IP 每日
  demo_global_day: 200, // 全站每日（燒錢上限的主保險）
  demo_max_tokens: 512, // 強制的回覆長度上限
  maxInputChars: 4000 // 整包輸入字數上限（不進 settings，硬編碼）
};

export interface DemoCfg {
  on: boolean; // demo_mode='1' 且 demo_channel 有設才算開
  channel: string;
  models: string[]; // 白名單；空陣列＝該渠道全部模型
  perMin: number;
  perIpDay: number;
  globalDay: number;
  maxTokens: number;
}

function intOr(v: unknown, dft: number): number {
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) && n > 0 ? n : dft;
}

/** 讀 demo 設定（settings 表 demo_* 鍵；任何失敗＝視為關閉）。 */
export async function demoCfg(env: Env): Promise<DemoCfg> {
  const off: DemoCfg = {
    on: false,
    channel: "",
    models: [],
    perMin: 0,
    perIpDay: 0,
    globalDay: 0,
    maxTokens: 0
  };
  try {
    if (!env || !env.DB) return off;
    const rs = await env.DB.prepare(
      "SELECT k,v FROM settings WHERE k IN ('demo_mode','demo_channel','demo_models','demo_per_min','demo_per_ip_day','demo_global_day','demo_max_tokens')"
    ).all();
    const st: Record<string, string> = {};
    for (const r of (rs.results || []) as { k: string; v: string }[]) st[r.k] = r.v;
    const channel = String(st.demo_channel || "").trim();
    if (st.demo_mode !== "1" || !channel) return off;
    return {
      on: true,
      channel: channel,
      models: String(st.demo_models || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      perMin: intOr(st.demo_per_min, DEMO_DEFAULTS.demo_per_min),
      perIpDay: intOr(st.demo_per_ip_day, DEMO_DEFAULTS.demo_per_ip_day),
      globalDay: intOr(st.demo_global_day, DEMO_DEFAULTS.demo_global_day),
      maxTokens: intOr(st.demo_max_tokens, DEMO_DEFAULTS.demo_max_tokens)
    };
  } catch (e) {
    return off;
  }
}

/**
 * demo 專用的 users 列（google_sub='demo:public'）— 懶建、全站一列。
 * 只是 req_log 的記帳身分（成本記帳自然涵蓋 demo 流量），永遠不可能登入：
 * OAuth 的 sub 是數字、dev 登入是 dev:<email>，都撞不到 'demo:public'；status 也保持 pending。
 */
export async function demoUser(env: Env): Promise<UserRow> {
  const sel = () => env.DB.prepare("SELECT * FROM users WHERE google_sub='demo:public'").first<UserRow>();
  let u = await sel();
  if (u) return u;
  await env.DB.prepare(
    "INSERT OR IGNORE INTO users (google_sub,email,name,status,services,created_at) " +
      "VALUES ('demo:public','','體驗模式（匿名訪客合計）','pending','',?1)"
  )
    .bind(new Date().toISOString())
    .run();
  u = await sel();
  return u!;
}

export type DemoCheckResult = { ok: true; resp?: undefined } | { ok: false; resp: Response };

/**
 * fail-closed 限流：每 IP（分鐘＋日）＋全站（日）都要過才放行；
 * DO 沒綁定或丟例外 → 503（絕不放行），並寫 errlog（src=demo.do，告警撈得到）。
 * 順序註記：IP 檢查先扣、全站再擋的話 IP 額度會白扣 1 — 對匿名體驗流量無所謂。
 */
export async function demoCheck(env: Env, cfg: DemoCfg, request: Request): Promise<DemoCheckResult> {
  try {
    if (!env.RATE_LIMITER) throw new Error("RATE_LIMITER 未綁定");
    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    const ipStub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName("demo-ip:" + ip));
    const r1 = await ipStub.check({ svc: "pg", perMin: cfg.perMin, perDay: cfg.perIpDay });
    if (!r1.ok) {
      const hint =
        r1.kind === "day"
          ? "這個 IP 今日的體驗額度用完了（" + r1.used + "/" + r1.limit + "）— 登入成為會員可獲得更高額度"
          : "請求太快了（體驗模式每分鐘上限 " + r1.limit + "），請稍等再試";
      return {
        ok: false,
        resp: json({ error: "demo-rate-limited", hint: hint }, 429, {
          "retry-after": r1.kind === "day" ? "3600" : "60"
        })
      };
    }
    const gStub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName("demo:global"));
    const r2 = await gStub.check({ svc: "pg", perMin: 1e9, perDay: cfg.globalDay }); // 全站只管日上限
    if (!r2.ok) {
      return {
        ok: false,
        resp: json(
          { error: "demo-quota-exceeded", hint: "今天的公共體驗額度整站用完了 — 登入成為會員即可繼續使用" },
          429,
          { "retry-after": "3600" }
        )
      };
    }
    return { ok: true };
  } catch (e) {
    await reportErrorNow(env, "demo.do", e); // fail-closed 也要留痕（Telegram 告警掃得到）
    return {
      ok: false,
      resp: json({ error: "demo-unavailable", hint: "體驗模式暫時無法使用，請稍後再試或登入" }, 503)
    };
  }
}
