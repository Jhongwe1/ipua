// @ts-check
// lib/quota.js — 計量與配額（2026-07-14 v1.0.0 上線）。
//
// 設計拍板（見 v1.0.0improveplan.md）：
//   * 中轉維持共享金鑰＋計量配額（BYOK 留 v2）；站長完全豁免（避免自己的 agent 被 429）。
//   * 配額計數直接 COUNT req_log（走 (user_id,svc,ts) 索引；流量小不做聚合表）。
//   * 全域預設存 settings（quota_relay_day / quota_pg_day / rl_per_min），
//     個人覆寫存 users 同名欄位（NULL＝用全域）；程式內建 QUOTA_DEFAULTS 當最後防線。
//   * 計量／配額任何一步壞掉都「放行」— 觀測功能絕不弄掛正職服務。
import { json } from "./site.js";
import { isAdminUser } from "./auth.js";

export const QUOTA_DEFAULTS = { quota_relay_day: 500, quota_pg_day: 200, rl_per_min: 30 };

/** @param {unknown} v @param {number} dft @returns {number} */
function intOr(v, dft) {
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) && n >= 0 ? n : dft;
}

/** 今天（UTC）0 點的 ISO 字串 — req_log.ts 也是 ISO，字典序比較即可。 */
export function utcDayStart() {
  return new Date().toISOString().slice(0, 10) + "T00:00:00.000Z";
}

/**
 * 配額檢查。站長直接放行；一個 D1 batch 讀全域設定＋兩個 COUNT（UTC 日窗＋滾動 60 秒）。
 * 個人覆寫欄位（users.quota_*／rl_per_min，NULL＝沒設）優先於全域 settings，再退程式預設。
 * @param {any} env
 * @param {any} user users 整列
 * @param {'relay'|'pg'} svc
 * @returns {Promise<{ok:true}|{ok:false, resp:Response}>}
 */
export async function checkQuota(env, user, svc) {
  try {
    if (!env || !env.DB || !user) return { ok: true };
    if (isAdminUser(user, env)) return { ok: true };   // 站長全豁免
    const now = Date.now();
    const dayStart = utcDayStart();
    const minAgo = new Date(now - 60e3).toISOString();
    const res = await env.DB.batch([
      env.DB.prepare("SELECT k,v FROM settings WHERE k IN ('quota_relay_day','quota_pg_day','rl_per_min')"),
      env.DB.prepare("SELECT COUNT(*) AS c FROM req_log WHERE user_id=?1 AND svc=?2 AND ts>=?3")
        .bind(user.id, svc, dayStart),
      env.DB.prepare("SELECT COUNT(*) AS c FROM req_log WHERE user_id=?1 AND ts>=?2")
        .bind(user.id, minAgo)
    ]);
    /** @type {Record<string,string>} */
    const st = {};
    for (const r of (res[0].results || [])) st[r.k] = r.v;
    const dayKey = svc === "relay" ? "quota_relay_day" : "quota_pg_day";
    const dayDefault = intOr(st[dayKey], svc === "relay" ? QUOTA_DEFAULTS.quota_relay_day : QUOTA_DEFAULTS.quota_pg_day);
    const dayLimit = user[dayKey] == null ? dayDefault : intOr(user[dayKey], dayDefault);
    const rlDefault = intOr(st.rl_per_min, QUOTA_DEFAULTS.rl_per_min);
    const rlLimit = user.rl_per_min == null ? rlDefault : intOr(user.rl_per_min, rlDefault);
    const usedDay = Number((res[1].results || [{ c: 0 }])[0].c) || 0;
    const usedMin = Number((res[2].results || [{ c: 0 }])[0].c) || 0;

    if (usedDay >= dayLimit) {
      const reset = new Date(dayStart);
      reset.setUTCDate(reset.getUTCDate() + 1);
      const secs = Math.max(1, Math.ceil((reset.getTime() - now) / 1000));
      return { ok: false, resp: json({
        error: "quota-exceeded",
        hint: "今日額度用完了（" + usedDay + "/" + dayLimit + "），UTC 午夜重置；需要更多請聯絡站長",
        used: usedDay, limit: dayLimit, reset: reset.toISOString()
      }, 429, { "retry-after": String(secs) }) };
    }
    if (usedMin >= rlLimit) {
      return { ok: false, resp: json({
        error: "rate-limited",
        hint: "請求太快了（每分鐘上限 " + rlLimit + "），請稍等再試",
        used: usedMin, limit: rlLimit, reset: new Date(now + 60e3).toISOString()
      }, 429, { "retry-after": "60" }) };
    }
    return { ok: true };
  } catch (e) {
    return { ok: true };   // 配額系統故障 → 放行，服務照跑
  }
}

/**
 * 寫一列 req_log。永不 throw、回傳的 Promise 永不 reject（呼叫端可安心丟給 waitUntil）。
 * 1% 機率順手清 90 天前的舊列（免 cron 的簡易保養）。
 * @param {any} env
 * @param {{user_id:number, svc:'relay'|'pg', channel?:string, model?:string, status?:number,
 *          dur_ms?:number|null, ttfb_ms?:number|null, tokens_in?:number|null, tokens_out?:number|null}} rec
 * @returns {Promise<void>}
 */
export async function logReq(env, rec) {
  try {
    const stmts = [
      env.DB.prepare(
        "INSERT INTO req_log (ts,user_id,svc,channel,model,status,dur_ms,ttfb_ms,tokens_in,tokens_out) " +
        "VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)"
      ).bind(
        new Date().toISOString(), rec.user_id, rec.svc, rec.channel || "", rec.model || "",
        rec.status || 0,
        rec.dur_ms == null ? null : rec.dur_ms,
        rec.ttfb_ms == null ? null : rec.ttfb_ms,
        rec.tokens_in == null ? null : rec.tokens_in,
        rec.tokens_out == null ? null : rec.tokens_out
      )
    ];
    if (Math.random() < 0.01) {
      stmts.push(env.DB.prepare("DELETE FROM req_log WHERE ts < ?1")
        .bind(new Date(Date.now() - 90 * 86400e3).toISOString()));
    }
    await env.DB.batch(stmts);
  } catch (e) { /* 計量失敗絕不影響服務 */ }
}

/**
 * 從「回應」文字（SSE 或整包 JSON 皆可）掃出最後出現的 model 與 token 用量。
 * 用 regex 掃字串而不解析 JSON — 三家（OpenAI/Anthropic/Gemini）欄位名都認，
 * 也絕不需要緩衝／解析會員的請求本體。取「最後一個」是因為 usage 都在串流尾端才完整
 * （anthropic 的 message_start 只有 input，message_delta 最後補 output — 各取各的最後值）。
 * @param {string} text
 * @returns {{model:string, tokens_in:number|null, tokens_out:number|null}}
 */
export function scanUsage(text) {
  /** @param {RegExp} re @returns {string|null} */
  const last = (re) => {
    let m, out = null;
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

/**
 * /api/me 的今日用量摘要：只回會員「有權限的服務」的數字；站長 limit 一律 null（無上限）。
 * 兩個服務都沒權限回 null（前端就不顯示）。任何失敗也回 null — 摘要壞了不影響登入。
 * @param {any} env
 * @param {any} user
 * @param {string[]} services userServices() 的結果
 * @returns {Promise<null | {relay_today?:number, relay_limit?:number|null, pg_today?:number, pg_limit?:number|null}>}
 */
export async function usageSummary(env, user, services) {
  const wantRelay = services.indexOf("relay") >= 0;
  const wantPg = services.indexOf("playground") >= 0;
  if ((!wantRelay && !wantPg) || !env || !env.DB) return null;
  try {
    const dayStart = utcDayStart();
    const res = await env.DB.batch([
      env.DB.prepare("SELECT k,v FROM settings WHERE k IN ('quota_relay_day','quota_pg_day')"),
      env.DB.prepare("SELECT COUNT(*) AS c FROM req_log WHERE user_id=?1 AND svc='relay' AND ts>=?2").bind(user.id, dayStart),
      env.DB.prepare("SELECT COUNT(*) AS c FROM req_log WHERE user_id=?1 AND svc='pg' AND ts>=?2").bind(user.id, dayStart)
    ]);
    /** @type {Record<string,string>} */
    const st = {};
    for (const r of (res[0].results || [])) st[r.k] = r.v;
    const admin = isAdminUser(user, env);
    /** @type {{relay_today?:number, relay_limit?:number|null, pg_today?:number, pg_limit?:number|null}} */
    const out = {};
    if (wantRelay) {
      const dft = intOr(st.quota_relay_day, QUOTA_DEFAULTS.quota_relay_day);
      out.relay_today = Number((res[1].results || [{ c: 0 }])[0].c) || 0;
      out.relay_limit = admin ? null : (user.quota_relay_day == null ? dft : intOr(user.quota_relay_day, dft));
    }
    if (wantPg) {
      const dft = intOr(st.quota_pg_day, QUOTA_DEFAULTS.quota_pg_day);
      out.pg_today = Number((res[2].results || [{ c: 0 }])[0].c) || 0;
      out.pg_limit = admin ? null : (user.quota_pg_day == null ? dft : intOr(user.quota_pg_day, dft));
    }
    return out;
  } catch (e) { return null; }
}
