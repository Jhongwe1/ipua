// GET /api/playground/models — Playground 可選的模型清單（依渠道分組）。
// 要有 playground 服務（或管理員金鑰）；不含任何上游金鑰與網址。
// Phase K：demo 開著時，匿名訪客拿得到「demo 渠道 × 白名單模型」這一組（渠道顯示名遮成「體驗模式」，
// 不洩漏管理員取的渠道名）；demo 關 → 照舊 401。
import { json } from "../../../lib/site.js";
import { pgUser, chModels } from "../../../lib/playground.js";
import { demoCfg } from "../../../lib/demo.js";
import type { ChannelRow, RouteCtx } from "../../../types.js";

export async function onRequestGet({ request, env }: RouteCtx): Promise<Response> {
  const url = new URL(request.url);
  if (!env.DB) return json({ error: "no-db" }, 500);
  const who = await pgUser(request, env, url);
  if (who.err) {
    if (!request.headers.get("authorization")) {
      const cfg = await demoCfg(env);
      if (cfg.on) {
        try {
          const ch = await env.DB.prepare("SELECT slug,models FROM relay_channels WHERE slug=?1 AND enabled=1")
            .bind(cfg.channel)
            .first<ChannelRow>();
          let models = ch ? chModels(ch) : [];
          if (cfg.models.length) models = models.filter((m) => cfg.models.indexOf(m) >= 0);
          return json({
            demo: true,
            rows: models.length ? [{ slug: cfg.channel, name: "體驗模式", models: models }] : []
          });
        } catch (e) {
          return json({ demo: true, rows: [] });
        }
      }
    }
    return who.err;
  }
  try {
    const res = await env.DB.prepare(
      "SELECT slug,name,models FROM relay_channels WHERE enabled=1 ORDER BY id"
    ).all();
    // 不回 kind：kind 等於標示真實提供商（openai/anthropic/gemini），Playground 前端也用不到
    const rows = ((res.results || []) as { slug: string; name: string; models?: unknown }[])
      .map(function (r) {
        return { slug: r.slug, name: r.name, models: chModels(r) };
      })
      .filter(function (r) {
        return r.models.length;
      });
    return json({ rows: rows });
  } catch (e: any) {
    return json({ error: "query-failed", detail: String((e && e.message) || e) }, 500);
  }
}
