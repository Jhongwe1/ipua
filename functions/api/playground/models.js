// GET /api/playground/models — Playground 可選的模型清單（依渠道分組）。
// 要有 playground 服務（或站長金鑰）；不含任何上游金鑰與網址。
import { json } from "../../../lib/site.js";
import { pgUser, chModels } from "../../../lib/playground.js";

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  if (!env.DB) return json({ error: "no-db" }, 500);
  const who = await pgUser(request, env, url);
  if (who.err) return who.err;
  try {
    const res = await env.DB.prepare(
      "SELECT slug,name,models FROM relay_channels WHERE enabled=1 ORDER BY id"
    ).all();
    // 不回 kind：kind 等於標示真實提供商（openai/anthropic/gemini），Playground 前端也用不到
    const rows = (res.results || []).map(function (r) {
      return { slug: r.slug, name: r.name, models: chModels(r) };
    }).filter(function (r) { return r.models.length; });
    return json({ rows: rows });
  } catch (e) {
    return json({ error: "query-failed", detail: String(e && e.message || e) }, 500);
  }
}
