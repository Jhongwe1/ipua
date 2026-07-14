// PUT /api/admin/settings — 站長專用：改網站設定。**本體帶哪個鍵就改哪個鍵**（沒帶的不動）：
//   brand:   新站名（最長 60 字）；空字串＝刪掉自訂站名＝還原內建預設（lib/site.js 的 BRAND）。
//   pg_open: true/false — Playground 對所有登入會員開放（不必逐人批准；封鎖者照擋）。
//            存 settings 表 pg_open='1'；false＝刪鍵＝回到逐人批准。
//   quota_relay_day / quota_pg_day / rl_per_min（2026-07-14 配額全域預設）：
//            正整數＝覆寫程式內建預設（lib/quota.js QUOTA_DEFAULTS）；null 或空字串＝刪鍵＝回到內建。
//   relay_meter: true/false — 中轉計量 pump 的總開關（false 存 '0'＝退回純直通；true＝刪鍵＝預設開）。
//            計量 pump 出怪問題時的免部署保險，平常不要動。
// 回 { ok, brand, custom, pg_open, quota_relay_day, quota_pg_day, rl_per_min, relay_meter }（改完的現況）。
import { json, BRAND } from "../../../lib/site.js";
import { adminOk, pgOpenAll } from "../../../lib/auth.js";
import { QUOTA_DEFAULTS } from "../../../lib/quota.js";

const QUOTA_KEYS = ["quota_relay_day", "quota_pg_day", "rl_per_min"];
const ALL_KEYS = ["brand", "pg_open", "relay_meter"].concat(QUOTA_KEYS);

export async function onRequestPut({ request, env }) {
  const url = new URL(request.url);
  if (!(await adminOk(request, env, url))) return json({ error: "unauthorized" }, 401);
  if (!env.DB) return json({ error: "no-db" }, 500);

  let body = null;
  try { body = await request.json(); } catch (e) {}
  if (!body || typeof body !== "object") return json({ error: "bad-input", hint: "需要 JSON 本體" }, 400);
  if (!ALL_KEYS.some(function (k) { return k in body; })) {
    return json({ error: "bad-input", hint: "至少要帶一個設定鍵（" + ALL_KEYS.join(" / ") + "）" }, 400);
  }

  const put = function (k, v) {
    return env.DB.prepare("INSERT INTO settings (k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(k, v).run();
  };
  const del = function (k) {
    return env.DB.prepare("DELETE FROM settings WHERE k=?1").bind(k).run();
  };

  try {
    if ("brand" in body) {
      const brand = String(body.brand == null ? "" : body.brand).trim().slice(0, 60);
      if (!brand) await del("brand");
      else await put("brand", brand);
    }
    if ("pg_open" in body) {
      if (body.pg_open) await put("pg_open", "1");
      else await del("pg_open");
    }
    for (const k of QUOTA_KEYS) {
      if (!(k in body)) continue;
      const v = body[k];
      if (v === null || v === "") { await del(k); continue; }
      const n = parseInt(v, 10);
      if (!Number.isFinite(n) || n < 1) {
        return json({ error: "bad-input", hint: k + " 要是正整數，或 null＝回到內建預設（" + QUOTA_DEFAULTS[k] + "）" }, 400);
      }
      await put(k, String(n));
    }
    if ("relay_meter" in body) {
      if (body.relay_meter) await del("relay_meter");   // 預設就是開
      else await put("relay_meter", "0");
    }

    // 回傳改完的現況（settings 沒鍵時顯示內建預設）
    const res = await env.DB.prepare(
      "SELECT k,v FROM settings WHERE k IN ('brand','quota_relay_day','quota_pg_day','rl_per_min','relay_meter')"
    ).all();
    const st = {};
    (res.results || []).forEach(function (r) { st[r.k] = r.v; });
    return json({
      ok: true,
      brand: st.brand || BRAND,
      custom: !!st.brand,
      pg_open: await pgOpenAll(env),
      quota_relay_day: st.quota_relay_day ? parseInt(st.quota_relay_day, 10) : QUOTA_DEFAULTS.quota_relay_day,
      quota_pg_day: st.quota_pg_day ? parseInt(st.quota_pg_day, 10) : QUOTA_DEFAULTS.quota_pg_day,
      rl_per_min: st.rl_per_min ? parseInt(st.rl_per_min, 10) : QUOTA_DEFAULTS.rl_per_min,
      relay_meter: st.relay_meter !== "0"
    });
  } catch (e) {
    return json({ error: "save-failed", detail: String(e && e.message || e) }, 500);
  }
}
