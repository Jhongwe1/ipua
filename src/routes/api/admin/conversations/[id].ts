// GET /api/admin/conversations/<編號> — 管理員專用：讀任何會員的一則對話（含全部訊息）。
// 回 { conv, messages }：conv 額外帶 email／name（誰的對話），messages 依時間舊→新（閱讀順序）。
// 會員版 /api/playground/conversations/{id} 只看得到自己的；這支是管理視角、不限擁有者。
import { json } from "../../../../lib/site.js";
import { adminOk } from "../../../../lib/auth.js";
import type { RouteCtx, Row } from "../../../../types.js";

export async function onRequestGet({ request, env, params }: RouteCtx): Promise<Response> {
  const url = new URL(request.url);
  if (!(await adminOk(request, env, url))) return json({ error: "unauthorized" }, 401);
  if (!env.DB) return json({ error: "no-db" }, 500);
  const id = parseInt(String(params.id), 10);
  if (!(id > 0)) return json({ error: "bad-input", hint: "對話編號要是正整數" }, 400);
  try {
    const conv = await env.DB.prepare(
      "SELECT c.*, u.email, u.name FROM pg_conversations c LEFT JOIN users u ON u.id=c.user_id WHERE c.id=?1"
    )
      .bind(id)
      .first<Row>();
    if (!conv) return json({ error: "not-found", hint: "找不到這個對話" }, 404);
    const res = await env.DB.prepare(
      "SELECT id,role,content,model,created_at FROM pg_messages WHERE conv_id=?1 ORDER BY id LIMIT 500"
    )
      .bind(id)
      .all();
    return json({ conv: conv, messages: res.results || [] });
  } catch (e: any) {
    return json({ error: "query-failed", detail: String((e && e.message) || e) }, 500);
  }
}
