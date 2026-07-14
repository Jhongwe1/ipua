// /api/admin/pages — 站長專用：自訂頁面（公開網址 /p/<slug>）。
//   GET  列出全部頁面（含草稿）
//   POST 新增頁面（slug 與 title 必填；slug 重複回 409）
// 驗證與其他站長 API 相同：Authorization: Bearer <LOGS_TOKEN>；localhost 開發免驗證。
import { json, SLUG_RE } from "../../../../lib/site.js";
import { adminOk } from "../../../../lib/auth.js";
import { audit } from "../../../../lib/observe.js";

// 欄位整理與上限（slug、title 必填；status 只收白名單值）。不合規回 null／錯誤字串。
export function cleanPage(b) {
  if (!b || typeof b !== "object") return { err: "需要 JSON 本體" };
  const slug = String(b.slug == null ? "" : b.slug).trim().toLowerCase();
  if (!SLUG_RE.test(slug)) return { err: "slug 只能用小寫英數與連字號（頭尾不能是連字號），最長 64 字" };
  const title = String(b.title == null ? "" : b.title).trim().slice(0, 200);
  if (!title) return { err: "標題不能是空的" };
  return {
    page: {
      slug: slug,
      title: title,
      summary: String(b.summary == null ? "" : b.summary).trim().slice(0, 500),
      body_md: String(b.body_md == null ? "" : b.body_md).slice(0, 200000),
      status: b.status === "published" ? "published" : "draft"
    }
  };
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  if (!(await adminOk(request, env, url))) return json({ error: "unauthorized" }, 401);
  if (!env.DB) return json({ error: "no-db" }, 500);
  try {
    const res = await env.DB.prepare(
      "SELECT id,slug,title,summary,status,created_at,updated_at FROM pages ORDER BY updated_at DESC LIMIT 500"
    ).all();
    return json({ rows: res.results || [] });
  } catch (e) {
    return json({ error: "query-failed", detail: String(e && e.message || e) }, 500);
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  if (!(await adminOk(request, env, url))) return json({ error: "unauthorized" }, 401);
  if (!env.DB) return json({ error: "no-db" }, 500);

  let body = null;
  try { body = await request.json(); } catch (e) {}
  const c = cleanPage(body);
  if (c.err) return json({ error: "bad-input", hint: c.err }, 400);
  const p = c.page;

  const now = new Date().toISOString();
  try {
    const r = await env.DB.prepare(
      "INSERT INTO pages (slug,title,summary,body_md,status,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?6)"
    ).bind(p.slug, p.title, p.summary, p.body_md, p.status, now).run();
    audit(env, function (pr) { context.waitUntil(pr); }, request, "pages.create", p.slug,
      p.title.slice(0, 80) + " [" + p.status + "]");
    return json({ id: r.meta.last_row_id, slug: p.slug, status: p.status, url: "/p/" + p.slug });
  } catch (e) {
    const msg = String(e && e.message || e);
    if (msg.indexOf("UNIQUE") >= 0) {
      return json({ error: "slug-taken", hint: "slug「" + p.slug + "」已經有頁面在用了" }, 409);
    }
    return json({ error: "insert-failed", detail: msg }, 500);
  }
}
