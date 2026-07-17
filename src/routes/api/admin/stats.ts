// GET /api/admin/stats?days=7 — 管理員專用：req_log 用量統計（/logs 用量分頁＋延遲/成本報告的數據源）。
// 回 {
//   days, since,
//   by_day:     每日×服務的請求數／平均耗時／平均首位元組／token 合計
//   by_channel: 服務×渠道×模型的彙總（含錯誤數；Phase J 起含 cost 估算，未定價＝null）
//   by_user:    每會員彙總（Phase J：請求數／tokens／cost 估算；帶 email、name 好認人）
//   durs:       最近的原始 dur_ms 值（上限 2000 筆，新的在前）— 前端自己算 p50/p95
//   cost_total: 期間估算成本合計（USD；只加得起來「有定價」的部分）
//   unpriced_models: 期間出現過但 model_prices 沒對上的模型名（提醒管理員補定價）
// }
// 成本＝JS 端對照 model_prices（精確 > 最長前綴，src/lib/cost.ts）— 估算值，僅供報告。
import { json } from "../../../lib/site.js";
import { adminOk } from "../../../lib/auth.js";
import { pickPrice, costUSD, type PriceRow } from "../../../lib/cost.js";
import type { RouteCtx, Row } from "../../../types.js";

export async function onRequestGet({ request, env }: RouteCtx): Promise<Response> {
  const url = new URL(request.url);
  if (!(await adminOk(request, env, url))) return json({ error: "unauthorized" }, 401);
  if (!env.DB) return json({ error: "no-db" }, 500);
  let days = parseInt(url.searchParams.get("days") || "", 10);
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
      ).bind(since),
      // 每會員×模型（成本要按模型定價算，先細分、JS 再彙總回每人一列）
      env.DB.prepare(
        "SELECT r.user_id, u.email, u.name, r.model, COUNT(*) AS n, " +
          "SUM(r.tokens_in) AS tokens_in, SUM(r.tokens_out) AS tokens_out " +
          "FROM req_log r LEFT JOIN users u ON u.id=r.user_id " +
          "WHERE r.ts>=?1 GROUP BY r.user_id, r.model"
      ).bind(since),
      env.DB.prepare("SELECT pattern,input_usd_per_m,output_usd_per_m FROM model_prices")
    ]);

    const prices = (res[4].results || []) as unknown as PriceRow[];
    const unpriced: Record<string, boolean> = {};
    let costTotal = 0;
    let anyPriced = false;

    // by_channel 每列補 cost（null＝該模型未定價）
    const byChannel = ((res[1].results || []) as Row[]).map((r) => {
      const model = String(r.model || "");
      const price = pickPrice(model, prices);
      const cost = costUSD(r.tokens_in as number | null, r.tokens_out as number | null, price);
      if (model && !price) unpriced[model] = true;
      if (cost != null) {
        costTotal += cost;
        anyPriced = true;
      }
      return Object.assign({}, r, { cost: cost });
    });

    // by_user：user×model 細分列 → 每人一列（cost 加得起來的部分加總；有任何未定價模型就標 unpriced）
    const perUser: Record<
      string,
      {
        user_id: number;
        email: string;
        name: string;
        n: number;
        tokens_in: number;
        tokens_out: number;
        cost: number | null;
        unpriced: boolean;
      }
    > = {};
    for (const r of (res[3].results || []) as Row[]) {
      const uid = Number(r.user_id);
      const cur = (perUser[uid] = perUser[uid] || {
        user_id: uid,
        email: String(r.email || ""),
        name: String(r.name || ""),
        n: 0,
        tokens_in: 0,
        tokens_out: 0,
        cost: null,
        unpriced: false
      });
      cur.n += Number(r.n) || 0;
      cur.tokens_in += Number(r.tokens_in) || 0;
      cur.tokens_out += Number(r.tokens_out) || 0;
      const model = String(r.model || "");
      const price = pickPrice(model, prices);
      const cost = costUSD(r.tokens_in as number | null, r.tokens_out as number | null, price);
      if (cost != null) cur.cost = (cur.cost || 0) + cost;
      if (model && !price) cur.unpriced = true;
    }
    const byUser = Object.values(perUser).sort((a, b) => b.n - a.n);

    return json({
      days: days,
      since: since,
      by_day: res[0].results || [],
      by_channel: byChannel,
      by_user: byUser,
      durs: res[2].results || [],
      cost_total: anyPriced ? costTotal : null,
      unpriced_models: Object.keys(unpriced).sort()
    });
  } catch (e: any) {
    return json({ error: "query-failed", detail: String((e && e.message) || e) }, 500);
  }
}
