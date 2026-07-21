// src/lib/quota.ts — 計量與配額（2026-07-14 v1.0.0 上線）。
//
// 設計拍板（見 v1.0.0improveplan.md）：
//   * 中轉維持共享金鑰＋計量配額（BYOK 留 v2）；管理員完全豁免（避免自己的 agent 被 429）。
//   * 配額計數直接 COUNT req_log（走 (user_id,svc,ts) 索引；流量小不做聚合表）。
//   * 全域預設存 settings（quota_relay_day / quota_pg_day / rl_per_min），
//     個人覆寫存 users 同名欄位（NULL＝用全域）；程式內建 QUOTA_DEFAULTS 當最後防線。
//   * 計量／配額任何一步壞掉都「放行」— 觀測功能絕不弄掛正職服務。
import { json } from "./site.js";
import { isAdminUser } from "./auth.js";
import { reportErrorNow } from "./observe.js";
import type { Env, UserRow } from "../types.js";

export const QUOTA_DEFAULTS = { quota_relay_day: 500, quota_pg_day: 200, rl_per_min: 30 };

// 名字帶著門檻（2026-07-22 改名）：demo.ts 有一支同名同簽章、但收 n>0 的孿生函式。
// 兩邊的語意各自站得住（配額 0＝完全禁用是合法設定；demo 的 0 只會是誤填），
// 問題出在「同名同簽章、行為不同」——讀到任一支都會以為自己知道另一支在做什麼。
// 把門檻放進呼叫端，兩者就不可能再被搞混。
function intAtLeast(v: unknown, dft: number, min: number): number {
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) && n >= min ? n : dft;
}

/** 今天（UTC）0 點的 ISO 字串 — req_log.ts 也是 ISO，字典序比較即可。 */
export function utcDayStart(): string {
  return new Date().toISOString().slice(0, 10) + "T00:00:00.000Z";
}

export type QuotaResult = { ok: true; resp?: undefined } | { ok: false; resp: Response };

// 429 組裝（DO 路徑與 D1 降級路徑共用同一套文案／形狀 — 對外契約不因 Phase H 改變）
// contact：管理員聯絡連結（settings.contact_url，跟未登入閘門那顆「聯絡我」鈕同一條）。
//   「請聯絡管理員」卻不給聯絡方式等於叫人自己想辦法 — 有設就把網址接在後面。
//   跟 hint 走同一個字串（不另開欄位）是為了讓 /relay 的 API 使用者也看得到：
//   他們拿到的就是這包 JSON，沒有前端可以幫忙渲染按鈕。
function dayDenied(
  used: number,
  limit: number,
  now: number,
  dayStart: string,
  contact?: string
): QuotaResult {
  const reset = new Date(dayStart);
  reset.setUTCDate(reset.getUTCDate() + 1);
  const secs = Math.max(1, Math.ceil((reset.getTime() - now) / 1000));
  const c = String(contact || "").trim();
  return {
    ok: false,
    resp: json(
      {
        error: "quota-exceeded",
        hint:
          "今日額度用完了（" +
          used +
          "/" +
          limit +
          "），UTC 午夜重置；需要更多請聯絡管理員" +
          (c ? "：" + c : ""),
        used: used,
        limit: limit,
        reset: reset.toISOString(),
        contact_url: c || undefined // 前端要做成可點的連結時用這欄，不必從 hint 裡撈
      },
      429,
      { "retry-after": String(secs) }
    )
  };
}
function minDenied(used: number, limit: number, now: number): QuotaResult {
  return {
    ok: false,
    resp: json(
      {
        error: "rate-limited",
        hint: "請求太快了（每分鐘上限 " + limit + "），請稍等再試",
        used: used,
        limit: limit,
        reset: new Date(now + 60e3).toISOString()
      },
      429,
      { "retry-after": "60" }
    )
  };
}

/**
 * 配額檢查。管理員直接放行；limit 三層優先序＝個人覆寫欄位（users.quota_*／rl_per_min，
 * NULL＝沒設）＞ 全域 settings ＞ 程式預設 — 算好才交給計數層。
 *
 * 計數層三層降級（Phase H，ADR-0007）：
 *   1) Durable Object 原子計數（settings quota_do='0' 可一鍵停用）— 修掉 COUNT-then-insert 競態
 *   2) DO 壞掉／沒綁定 → 退回 v1 的 D1 COUNT 路徑（近似值，堪用）
 *   3) 連 D1 都壞 → 放行 — 配額永遠不弄掛正職服務（demo 模式相反，fail-closed，見 Phase K）
 */
export async function checkQuota(env: Env, user: UserRow, svc: "relay" | "pg"): Promise<QuotaResult> {
  try {
    if (!env || !env.DB || !user) return { ok: true };
    if (isAdminUser(user, env)) return { ok: true }; // 管理員全豁免
    const now = Date.now();
    const dayStart = utcDayStart();
    const rs = await env.DB.prepare(
      // contact_url 一起撈（額度爆掉的 429 要附聯絡方式）— 塞進這句本來就要跑的查詢，
      // 不另開一次 D1 往返；沒設過就是空的，文案自動退回原本那句。
      "SELECT k,v FROM settings WHERE k IN ('quota_relay_day','quota_pg_day','rl_per_min','quota_do','contact_url')"
    ).all();
    const st: Record<string, string> = {};
    for (const r of (rs.results || []) as { k: string; v: string }[]) st[r.k] = r.v;
    const dayKey = svc === "relay" ? "quota_relay_day" : "quota_pg_day";
    const dayDefault = intAtLeast(
      st[dayKey],
      svc === "relay" ? QUOTA_DEFAULTS.quota_relay_day : QUOTA_DEFAULTS.quota_pg_day,
      0
    );
    const dayLimit = user[dayKey] == null ? dayDefault : intAtLeast(user[dayKey], dayDefault, 0);
    const rlDefault = intAtLeast(st.rl_per_min, QUOTA_DEFAULTS.rl_per_min, 0);
    const rlLimit = user.rl_per_min == null ? rlDefault : intAtLeast(user.rl_per_min, rlDefault, 0);

    // 第一層：DO 原子計數（每會員一顆實例；被擋的請求不吃額度）
    if (st.quota_do !== "0" && env.RATE_LIMITER) {
      try {
        const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName("u:" + user.id));
        const r = await stub.check({ svc: svc, perMin: rlLimit, perDay: dayLimit });
        if (r.ok) return { ok: true };
        return r.kind === "day"
          ? dayDenied(r.used, r.limit, now, dayStart, st.contact_url)
          : minDenied(r.used, r.limit, now);
      } catch (e) {
        await reportErrorNow(env, "quota.do", e, { user_id: user.id }); // 降級要留痕（告警掃 errlog）
      }
    }

    // 第二層：v1 的 D1 COUNT 路徑（併發下是近似值 — 當降級堪用，ADR-0002/0007）
    const res = await env.DB.batch([
      env.DB.prepare("SELECT COUNT(*) AS c FROM req_log WHERE user_id=?1 AND svc=?2 AND ts>=?3").bind(
        user.id,
        svc,
        dayStart
      ),
      env.DB.prepare("SELECT COUNT(*) AS c FROM req_log WHERE user_id=?1 AND ts>=?2").bind(
        user.id,
        new Date(now - 60e3).toISOString()
      )
    ]);
    const usedDay = Number(((res[0].results || [{ c: 0 }])[0] as { c?: unknown }).c) || 0;
    const usedMin = Number(((res[1].results || [{ c: 0 }])[0] as { c?: unknown }).c) || 0;
    if (usedDay >= dayLimit) return dayDenied(usedDay, dayLimit, now, dayStart, st.contact_url);
    if (usedMin >= rlLimit) return minDenied(usedMin, rlLimit, now);
    return { ok: true };
  } catch (e) {
    return { ok: true }; // 第三層：配額系統整組故障 → 放行，服務照跑
  }
}

export interface ReqLogRec {
  user_id: number;
  svc: "relay" | "pg";
  channel?: string;
  model?: string;
  status?: number;
  dur_ms?: number | null;
  ttfb_ms?: number | null;
  tokens_in?: number | null;
  tokens_out?: number | null;
}

/**
 * 寫一列 req_log。永不 throw、回傳的 Promise 永不 reject（呼叫端可安心丟給 waitUntil）。
 * 90 天輪替由每日 cron 的 purgeOld 負責（Phase I；v1 的 1% 隨機順手清已退役）。
 */
export async function logReq(env: Env, rec: ReqLogRec): Promise<void> {
  try {
    await env.DB.prepare(
      "INSERT INTO req_log (ts,user_id,svc,channel,model,status,dur_ms,ttfb_ms,tokens_in,tokens_out) " +
        "VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)"
    )
      .bind(
        new Date().toISOString(),
        rec.user_id,
        rec.svc,
        rec.channel || "",
        rec.model || "",
        rec.status || 0,
        rec.dur_ms == null ? null : rec.dur_ms,
        rec.ttfb_ms == null ? null : rec.ttfb_ms,
        rec.tokens_in == null ? null : rec.tokens_in,
        rec.tokens_out == null ? null : rec.tokens_out
      )
      .run();
  } catch (e) {
    /* 計量失敗絕不影響服務 */
  }
}

/**
 * 從「回應」文字（SSE 或整包 JSON 皆可）掃出最後出現的 model 與 token 用量。
 * 用 regex 掃字串而不解析 JSON — 三家（OpenAI/Anthropic/Gemini）欄位名都認，
 * 也絕不需要緩衝／解析會員的請求本體。取「最後一個」是因為 usage 都在串流尾端才完整
 * （anthropic 的 message_start 只有 input，message_delta 最後補 output — 各取各的最後值）。
 */
export function scanUsage(text: string): {
  model: string;
  tokens_in: number | null;
  tokens_out: number | null;
} {
  const last = (re: RegExp): string | null => {
    let m,
      out = null;
    while ((m = re.exec(text))) out = m[1];
    return out;
  };
  const model = last(/"model"\s*:\s*"([^"]{1,200})"/g) || "";
  const tin = last(/"(?:prompt_tokens|input_tokens|promptTokenCount)"\s*:\s*(\d+)/g);
  const tout = last(/"(?:completion_tokens|output_tokens|candidatesTokenCount)"\s*:\s*(\d+)/g);
  return {
    model: model,
    tokens_in: tin == null ? null : parseInt(tin, 10),
    tokens_out: tout == null ? null : parseInt(tout, 10)
  };
}

export interface UsageOut {
  relay_today?: number;
  relay_limit?: number | null;
  pg_today?: number;
  pg_limit?: number | null;
}

/**
 * /api/me 的今日用量摘要：只回會員「有權限的服務」的數字；管理員 limit 一律 null（無上限）。
 * 兩個服務都沒權限回 null（前端就不顯示）。任何失敗也回 null — 摘要壞了不影響登入。
 * services 是 userServices() 的結果。
 */
export async function usageSummary(env: Env, user: UserRow, services: string[]): Promise<UsageOut | null> {
  const wantRelay = services.indexOf("relay") >= 0;
  const wantPg = services.indexOf("playground") >= 0;
  if ((!wantRelay && !wantPg) || !env || !env.DB) return null;
  try {
    const dayStart = utcDayStart();
    const res = await env.DB.batch([
      env.DB.prepare("SELECT k,v FROM settings WHERE k IN ('quota_relay_day','quota_pg_day')"),
      env.DB.prepare("SELECT COUNT(*) AS c FROM req_log WHERE user_id=?1 AND svc='relay' AND ts>=?2").bind(
        user.id,
        dayStart
      ),
      env.DB.prepare("SELECT COUNT(*) AS c FROM req_log WHERE user_id=?1 AND svc='pg' AND ts>=?2").bind(
        user.id,
        dayStart
      )
    ]);
    const st: Record<string, string> = {};
    for (const r of (res[0].results || []) as { k: string; v: string }[]) st[r.k] = r.v;
    const admin = isAdminUser(user, env);
    const out: UsageOut = {};
    if (wantRelay) {
      const dft = intAtLeast(st.quota_relay_day, QUOTA_DEFAULTS.quota_relay_day, 0);
      out.relay_today = Number(((res[1].results || [{ c: 0 }])[0] as { c?: unknown }).c) || 0;
      out.relay_limit = admin
        ? null
        : user.quota_relay_day == null
          ? dft
          : intAtLeast(user.quota_relay_day, dft, 0);
    }
    if (wantPg) {
      const dft = intAtLeast(st.quota_pg_day, QUOTA_DEFAULTS.quota_pg_day, 0);
      out.pg_today = Number(((res[2].results || [{ c: 0 }])[0] as { c?: unknown }).c) || 0;
      out.pg_limit = admin ? null : user.quota_pg_day == null ? dft : intAtLeast(user.quota_pg_day, dft, 0);
    }
    return out;
  } catch (e) {
    return null;
  }
}
