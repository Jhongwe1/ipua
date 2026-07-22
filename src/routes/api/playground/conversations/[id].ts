// /api/playground/conversations/<編號> — 只能動自己的對話。
//   GET    對話＋全部訊息（畫歷史對話用）
//   PUT    { title } 改名
//   DELETE 刪除對話（連同訊息，不可復原）
import { json } from "../../../../lib/site.js";
import { pgUser, dumbCfg } from "../../../../lib/playground.js";
import { isAdminUser } from "../../../../lib/auth.js";
import type { Env, Row, RouteCtx, UserRow } from "../../../../types.js";

async function ownConv(env: Env, user: UserRow, params: RouteCtx["params"]): Promise<Row | null> {
  const id = parseInt(String(params.id), 10);
  if (!(id > 0)) return null;
  return await env.DB.prepare("SELECT * FROM pg_conversations WHERE id=?1 AND user_id=?2")
    .bind(id, user.id)
    .first<Row>();
}

export async function onRequestGet({ request, env, params }: RouteCtx): Promise<Response> {
  const url = new URL(request.url);
  if (!env.DB) return json({ error: "no-db" }, 500);
  const who = await pgUser(request, env, url);
  if (who.err) return who.err;
  const conv = await ownConv(env, who.user, params);
  if (!conv) return json({ error: "not-found", hint: "找不到這個對話" }, 404);
  try {
    const res = await env.DB.prepare(
      "SELECT id,role,content,model,created_at FROM pg_messages WHERE conv_id=?1 ORDER BY id LIMIT 500"
    )
      .bind(conv.id)
      .all();
    const messages = (res.results || []) as Row[];
    // Dumb mode（v2.2）：會員從回讀也不能得知正在用的模型 — channel/model 一律遮空
    if (!isAdminUser(who.user, env) && (await dumbCfg(env)).on) {
      (conv as Row).channel = "";
      (conv as Row).model = "";
      for (const m of messages) m.model = "";
    }
    return json({ conv: conv, messages: messages });
  } catch (e: any) {
    return json({ error: "query-failed", detail: String((e && e.message) || e) }, 500);
  }
}

export async function onRequestPut({ request, env, params }: RouteCtx): Promise<Response> {
  const url = new URL(request.url);
  if (!env.DB) return json({ error: "no-db" }, 500);
  const who = await pgUser(request, env, url);
  if (who.err) return who.err;
  const conv = await ownConv(env, who.user, params);
  if (!conv) return json({ error: "not-found", hint: "找不到這個對話" }, 404);
  let b: any = null;
  try {
    b = await request.json();
  } catch (e) {}
  const title = String((b && b.title) || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  if (!title) return json({ error: "bad-input", hint: "title 不能是空的" }, 400);
  try {
    await env.DB.prepare("UPDATE pg_conversations SET title=?1 WHERE id=?2").bind(title, conv.id).run();
    return json({ ok: true, title: title });
  } catch (e: any) {
    return json({ error: "save-failed", detail: String((e && e.message) || e) }, 500);
  }
}

export async function onRequestDelete({ request, env, params }: RouteCtx): Promise<Response> {
  const url = new URL(request.url);
  if (!env.DB) return json({ error: "no-db" }, 500);
  const who = await pgUser(request, env, url);
  if (who.err) return who.err;
  const conv = await ownConv(env, who.user, params);
  if (!conv) return json({ error: "not-found", hint: "找不到這個對話" }, 404);
  try {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM pg_messages WHERE conv_id=?1").bind(conv.id),
      env.DB.prepare("DELETE FROM pg_conversations WHERE id=?1").bind(conv.id)
    ]);
    return json({ ok: true });
  } catch (e: any) {
    return json({ error: "delete-failed", detail: String((e && e.message) || e) }, 500);
  }
}
