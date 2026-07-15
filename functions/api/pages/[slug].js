// GET /api/pages/<slug> — 公開：讀單一「已發佈」自訂頁面（含 Markdown 原稿 body_md）。
// 加 ?html=1 會多回 body_html（伺服器用 marked 轉好的 HTML，跟 /p/<slug> 頁同設定）。
import { json, SLUG_RE } from "../../../lib/site.js";
import { marked } from "../../../lib/vendor/marked.mjs";
import { sanitizeHtml } from "../../../lib/sanitize.js";

const MD_OPTS = { gfm: true, breaks: true, async: false };

export async function onRequestGet({ request, env, params }) {
  if (!env.DB) return json({ error: "no-db" }, 500);
  const slug = String(params.slug || "").toLowerCase();
  if (!SLUG_RE.test(slug)) return json({ error: "bad-slug" }, 400);

  try {
    const row = await env.DB.prepare(
      "SELECT id,slug,title,summary,body_md,created_at,updated_at FROM pages WHERE slug=?1 AND status='published'"
    ).bind(slug).first();
    if (!row) return json({ error: "not-found" }, 404);

    const url = new URL(request.url);
    if (url.searchParams.get("html") === "1") {
      row.body_html = sanitizeHtml(marked.parse(row.body_md || "", MD_OPTS));
    }
    return json({ row: row });
  } catch (e) {
    return json({ error: "query-failed", detail: String(e && e.message || e) }, 500);
  }
}
