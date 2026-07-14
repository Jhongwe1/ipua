// /api/admin/pages/<編號或slug> — 站長專用：GET 讀單頁（含內文原稿）、PUT 更新、DELETE 刪除。
// <key> 純數字＝用編號找，其他＝用 slug 找（agent 用 slug 操作比較直覺）。
// PUT 跟文章一樣是「整包覆蓋」：先 GET 拿舊資料、改完整包送回；slug 也可以在 PUT 裡改（等於搬家）。
import { json, SLUG_RE } from "../../../../lib/site.js";
import { adminOk } from "../../../../lib/auth.js";
import { audit } from "../../../../lib/observe.js";
import { cleanPage } from "./index.js";

// 依 key 找頁面：回 row 或 null；key 不合法回 undefined
async function findPage(env, key) {
  const k = String(key || "");
  if (/^\d+$/.test(k)) {
    return env.DB.prepare("SELECT * FROM pages WHERE id=?1").bind(parseInt(k, 10)).first();
  }
  const slug = k.toLowerCase();
  if (!SLUG_RE.test(slug)) return undefined;
  return env.DB.prepare("SELECT * FROM pages WHERE slug=?1").bind(slug).first();
}

export async function onRequestGet({ request, env, params }) {
  const url = new URL(request.url);
  if (!(await adminOk(request, env, url))) return json({ error: "unauthorized" }, 401);
  if (!env.DB) return json({ error: "no-db" }, 500);
  try {
    const row = await findPage(env, params.key);
    if (row === undefined) return json({ error: "bad-slug" }, 400);
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
  if (!env.DB) return json({ error: "no-db" }, 500);

  let body = null;
  try { body = await request.json(); } catch (e) {}
  const c = cleanPage(body);
  if (c.err) return json({ error: "bad-input", hint: c.err }, 400);
  const p = c.page;

  try {
    const old = await findPage(env, params.key);
    if (old === undefined) return json({ error: "bad-slug" }, 400);
    if (!old) return json({ error: "not-found" }, 404);
    await env.DB.prepare(
      "UPDATE pages SET slug=?1,title=?2,summary=?3,body_md=?4,status=?5,updated_at=?6 WHERE id=?7"
    ).bind(p.slug, p.title, p.summary, p.body_md, p.status, new Date().toISOString(), old.id).run();
    audit(env, function (pr) { context.waitUntil(pr); }, request, "pages.update", p.slug,
      p.title.slice(0, 80) + " [" + p.status + "]" + (old.slug !== p.slug ? "（原 " + old.slug + "）" : ""));
    return json({ id: old.id, slug: p.slug, status: p.status, url: "/p/" + p.slug });
  } catch (e) {
    const msg = String(e && e.message || e);
    if (msg.indexOf("UNIQUE") >= 0) {
      return json({ error: "slug-taken", hint: "slug「" + p.slug + "」已經有別的頁面在用了" }, 409);
    }
    return json({ error: "update-failed", detail: msg }, 500);
  }
}

export async function onRequestDelete(context) {
  const { request, env, params } = context;
  const url = new URL(request.url);
  if (!(await adminOk(request, env, url))) return json({ error: "unauthorized" }, 401);
  if (!env.DB) return json({ error: "no-db" }, 500);
  try {
    const row = await findPage(env, params.key);
    if (row === undefined) return json({ error: "bad-slug" }, 400);
    if (!row) return json({ error: "not-found" }, 404);
    await env.DB.prepare("DELETE FROM pages WHERE id=?1").bind(row.id).run();
    audit(env, function (pr) { context.waitUntil(pr); }, request, "pages.delete", row.slug,
      (row.title || "").slice(0, 80));
    return json({ ok: true });
  } catch (e) {
    return json({ error: "delete-failed", detail: String(e && e.message || e) }, 500);
  }
}
