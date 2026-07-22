// GET /api/playground/conversations — 自己的對話列表（新→舊，最多 100 筆）。
// 對話在第一次送訊息時由 /api/playground/chat 自動建立，這裡只有讀。
import { json } from "../../../../lib/site.js";
import { pgUser, dumbCfg } from "../../../../lib/playground.js";
import { isAdminUser } from "../../../../lib/auth.js";
import type { Row, RouteCtx } from "../../../../types.js";

export async function onRequestGet({ request, env }: RouteCtx): Promise<Response> {
  const url = new URL(request.url);
  if (!env.DB) return json({ error: "no-db" }, 500);
  const who = await pgUser(request, env, url);
  if (who.err) return who.err;
  try {
    const res = await env.DB.prepare(
      "SELECT id,title,channel,model,created_at,updated_at FROM pg_conversations WHERE user_id=?1 ORDER BY updated_at DESC LIMIT 100"
    )
      .bind(who.user.id)
      .all();
    const rows = (res.results || []) as Row[];
    // Dumb mode（v2.2）：列表也遮掉 channel/model — 會員不能得知正在用的模型
    if (!isAdminUser(who.user, env) && (await dumbCfg(env)).on) {
      for (const r of rows) {
        r.channel = "";
        r.model = "";
      }
    }
    return json({ rows: rows });
  } catch (e: any) {
    return json({ error: "query-failed", detail: String((e && e.message) || e) }, 500);
  }
}
