// src/lib/demo.ts — Demo 體驗模式（v2.0.0 Phase K，ADR-0009）。
// 讓「完全沒登入」的訪客在 /playground 直接試聊：鎖定管理員指定的渠道與模型白名單、
// 輸入 4k 字上限、選填的回覆長度上限、對話存進 D1 但只有管理員看得到（見 demoUser）。
//
// 限流哲學與會員路徑「刻意相反」（ADR-0009 記載這個不對稱）：
//   會員配額 fail-open（配額系統壞了照樣放行 — 服務優先）；
//   demo 配額 **fail-closed**（DO 壞了直接 503 — 匿名流量寧可不服務，也不給人白嫖燒錢）。
// 雙保險：每 IP 一顆 DO（demo-ip:<ip>，分鐘＋日）＋全站一顆（demo:global，日）。
// 最壞燒錢上限＝demo_global_day × demo_max_tokens；demo_max_tokens 沒填（預設）＝不壓長度，
// 天花板就只剩「則數 × 模型自己的上限」— 要硬性壓成本就去 /settings 填一個數字。
import { json } from "./site.js";
import { reportErrorNow } from "./observe.js";
import type { Env, UserRow } from "../types.js";

export const DEMO_DEFAULTS = {
  demo_per_min: 3, // 每 IP 每分鐘
  demo_per_ip_day: 10, // 每 IP 每日
  demo_global_day: 200, // 全站每日（燒錢上限的主保險）
  demo_max_tokens: 0, // 回覆長度上限；0＝不限（沒填就跟會員路徑一樣不對上游設 max_tokens）
  maxInputChars: 4000 // 整包輸入字數上限（不進 settings，硬編碼）
};

export interface DemoCfg {
  on: boolean; // demo_mode='1' 且 demo_channel 有設才算開
  channel: string;
  models: string[]; // 白名單；空陣列＝該渠道全部模型
  perMin: number;
  perIpDay: number;
  globalDay: number;
  maxTokens: number; // 0＝不限（buildUpstream 收到 0 就不設 max_tokens）
  contactUrl: string; // settings.contact_url — 額度用完的 429 附上去（沒設＝空字串）
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
    maxTokens: 0,
    contactUrl: ""
  };
  try {
    if (!env || !env.DB) return off;
    const rs = await env.DB.prepare(
      // contact_url 順道撈：額度用完的 429 要附聯絡方式，塞進這句本來就要跑的查詢，
      // 比在拒絕路徑另外查一次省（免費方案的子請求與 CPU 都是額度）。
      "SELECT k,v FROM settings WHERE k IN ('demo_mode','demo_channel','demo_models','demo_per_min','demo_per_ip_day','demo_global_day','demo_max_tokens','contact_url')"
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
      maxTokens: intOr(st.demo_max_tokens, DEMO_DEFAULTS.demo_max_tokens),
      contactUrl: String(st.contact_url || "").trim()
    };
  } catch (e) {
    return off;
  }
}

/**
 * demo 專用的 users 列（google_sub='demo:public'）— 懶建、全站一列。
 * 兩個身分：req_log 的記帳身分（成本記帳自然涵蓋 demo 流量），以及 2026-07-21 起
 * **所有匿名試聊對話的擁有者**（全站訪客共用這一列）。
 *
 * 「擁有者」純粹是記帳歸屬，不等於有人能讀：這一列永遠不可能登入 —— OAuth 的 sub 是數字、
 * dev 登入是 dev:<email>，都撞不到 'demo:public'，status 也保持 pending。而
 * /api/playground/conversations（列表）與 .../{id}（讀取、改名、刪除）都先過 pgUser，
 * 匿名一律 401、會員則被 user_id 綁在自己身上 —— 所以沒有任何訪客拿得到這些對話，
 * 只有管理員的 /api/admin/conversations 看得到。
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
  // 額度用完的 429 附上管理員聯絡方式 — 跟會員路徑（lib/quota.ts 的 dayDenied）同一套：
  // hint 尾端接網址是給沒有前端可以畫按鈕的呼叫端看的，contact_url 欄位給 /playground
  // 做成「聯絡我」鈕（前端會把尾端那份切掉，免得同一條網址在同一格出現兩次）。
  const c = cfg.contactUrl;
  const withContact = (s: string) => s + (c ? "，或聯絡管理員：" + c : "");
  try {
    if (!env.RATE_LIMITER) throw new Error("RATE_LIMITER 未綁定");
    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    const ipStub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName("demo-ip:" + ip));
    const r1 = await ipStub.check({ svc: "pg", perMin: cfg.perMin, perDay: cfg.perIpDay });
    if (!r1.ok) {
      const day = r1.kind === "day";
      const hint = day
        ? withContact("今日的體驗額度用完了（" + r1.used + "/" + r1.limit + "）— 登入成為會員可獲得更高額度")
        : "請求太快了（體驗模式每分鐘上限 " + r1.limit + "），請稍等再試";
      return {
        ok: false,
        // 每分鐘那條等 60 秒就好，給聯絡鈕只是讓人白跑一趟 — 只有日額度用完才附
        resp: json({ error: "demo-rate-limited", hint: hint, contact_url: day && c ? c : undefined }, 429, {
          "retry-after": day ? "3600" : "60"
        })
      };
    }
    const gStub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName("demo:global"));
    const r2 = await gStub.check({ svc: "pg", perMin: 1e9, perDay: cfg.globalDay }); // 全站只管日上限
    if (!r2.ok) {
      return {
        ok: false,
        resp: json(
          {
            error: "demo-quota-exceeded",
            hint: withContact("今天的公共體驗額度整站用完了 — 登入成為會員即可繼續使用"),
            contact_url: c || undefined
          },
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
