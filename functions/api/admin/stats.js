// GET /api/admin/stats?days=7 — 站長專用：req_log 用量統計（/logs 用量分頁＋延遲/成本報告的數據源）。
// 回 {
//   days, since,
//   by_day:     每日×服務的請求數／平均耗時／平均首位元組／token 合計
//   by_channel: 服務×渠道×模型的彙總（含錯誤數）
//   durs:       最近的原始 dur_ms 值（上限 2000 筆，新的在前）— 前端自己算 p50/p95
// }
import { json } from "../../../lib/site.js";
import { adminOk } from "../../../lib/auth.js";

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  if (!(await adminOk(request, env, url))) return json({ error: "unauthorized" }, 401);
  if (!env.DB) return json({ error: "no-db" }, 500);
  let days = parseInt(url.searchParams.get("days"), 10);
  if (!days || days < 1 || days > 90) days = 7;
  const since = new Date(Date.now() - days * 86400e3).toISOString();
  try {
    const res = await env.DB.batch([
      env.DB.prepare(
        "SELECT substr(ts,1,10) AS d, svc, COUNT(*) AS n, ROUND(AVG(dur_ms)) AS avg_dur, " +
        "ROUND(AVG(ttfb_ms)) AS avg_ttfb, SUM(tokens_in) AS tokens_in, SUM(tokens_out) AS tokens_out, " +
        "SUM(CASE WHEN status>=400 OR status=0 THEN 1 ELSE 0 END) AS errs " +
        "FROM req_log WHERE ts>=?1 GROUP BY d, svc ORDER BY d DESC, svc"
      ).bind(since),
      env.DB.prepare(
        "SELECT svc, channel, model, COUNT(*) AS n, ROUND(AVG(dur_ms)) AS avg_dur, " +
        "ROUND(AVG(ttfb_ms)) AS avg_ttfb, SUM(tokens_in) AS tokens_in, SUM(tokens_out) AS tokens_out, " +
        "SUM(CASE WHEN status>=400 OR status=0 THEN 1 ELSE 0 END) AS errs " +
        "FROM req_log WHERE ts>=?1 GROUP BY svc, channel, model ORDER BY n DESC"
      ).bind(since),
      env.DB.prepare(
        "SELECT svc, dur_ms, ttfb_ms FROM req_log WHERE ts>=?1 AND dur_ms IS NOT NULL ORDER BY id DESC LIMIT 2000"
      ).bind(since)
    ]);
    return json({
      days: days,
      since: since,
      by_day: res[0].results || [],
      by_channel: res[1].results || [],
      durs: res[2].results || []
    });
  } catch (e) {
    return json({ error: "query-failed", detail: String(e && e.message || e) }, 500);
  }
}
