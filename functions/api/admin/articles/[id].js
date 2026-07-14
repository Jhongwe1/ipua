// /api/admin/articles/<編號> — 站長專用：GET 讀單篇（含內文原稿）、PUT 更新、DELETE 刪除。
import { json } from "../../../../lib/site.js";
import { adminOk } from "../../../../lib/auth.js";
import { audit } from "../../../../lib/observe.js";
import { cleanArticle } from "./index.js";

function idOf(params) {
  const id = parseInt(params.id, 10);
  return id > 0 ? id : null;
}

export async function onRequestGet({ request, env, params }) {
  const url = new URL(request.url);
  if (!(await adminOk(request, env, url))) return json({ error: "unauthorized" }, 401);
  const id = idOf(params);
  if (!id || !env.DB) return json({ error: "bad-id" }, 400);
  try {
    const row = await env.DB.prepare("SELECT * FROM articles WHERE id=?1").bind(id).first();
    if (!row) return json({ error: "not-found" }, 404);
    return json({ row: row });
  } catch (e) {
    return json({ error: "query-failed", detail: String(e && e.message || e) }, 500);
  }
}

export async function onRequestPut(context) {
  const { request, env, params } = context;
  const url = new URL(request.url);
  if (!(await adminOk(request, env, url))) return json({ error: "unauthorized" }, 401);
  const id = idOf(params);
  if (!id || !env.DB) return json({ error: "bad-id" }, 400);

  let body = null;
  try { body = await request.json(); } catch (e) {}
  const a = cleanArticle(body);
  if (!a) return json({ error: "bad-input", hint: "標題不能是空的" }, 400);

  try {
    const old = await env.DB.prepare("SELECT published_at FROM articles WHERE id=?1").bind(id).first();
    if (!old) return json({ error: "not-found" }, 404);
    const now = new Date().toISOString();
    // published_at 只在「第一次發佈」時寫入，之後編輯或轉回草稿都保留原時間（列表排序穩定）
    const publishedAt = old.published_at || (a.status === "published" ? now : null);
    await env.DB.prepare(
      "UPDATE articles SET category=?1,title=?2,summary=?3,cover=?4,body_md=?5,status=?6,updated_at=?7,published_at=?8 WHERE id=?9"
    ).bind(a.category, a.title, a.summary, a.cover, a.body_md, a.status, now, publishedAt, id).run();
    audit(env, function (p) { context.waitUntil(p); }, request, "articles.update", id,
      a.title.slice(0, 80) + " [" + a.category + "/" + a.status + "]");
    return json({ id: id, status: a.status });
  } catch (e) {
    return json({ error: "update-failed", detail: String(e && e.message || e) }, 500);
  }
}

export async function onRequestDelete(context) {
  const { request, env, params } = context;
  const url = new URL(request.url);
  if (!(await adminOk(request, env, url))) return json({ error: "unauthorized" }, 401);
  const id = idOf(params);
  if (!id || !env.DB) return json({ error: "bad-id" }, 400);
  try {
    const old = await env.DB.prepare("SELECT title FROM articles WHERE id=?1").bind(id).first();
    await env.DB.prepare("DELETE FROM articles WHERE id=?1").bind(id).run();
    audit(env, function (p) { context.waitUntil(p); }, request, "articles.delete", id,
      (old && old.title || "").slice(0, 80));
    return json({ ok: true });
  } catch (e) {
    return json({ error: "delete-failed", detail: String(e && e.message || e) }, 500);
  }
}
