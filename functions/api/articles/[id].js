// GET /api/articles/<編號> — 公開：讀單篇「已發佈」文章（含 Markdown 原稿 body_md）。
// 加 ?html=1 會多回 body_html（伺服器用 marked 轉好的 HTML，跟文章頁同設定）。
// 走 API 讀不會增加瀏覽數（views 只算真人看文章頁）。
import { json } from "../../../lib/site.js";
import { marked } from "../../../lib/vendor/marked.mjs";
import { sanitizeHtml } from "../../../lib/sanitize.js";

const MD_OPTS = { gfm: true, breaks: true, async: false };

export async function onRequestGet({ request, env, params }) {
  if (!env.DB) return json({ error: "no-db" }, 500);
  const id = parseInt(params.id, 10);
  if (!(id > 0)) return json({ error: "bad-id" }, 400);

  try {
    const row = await env.DB.prepare(
      "SELECT id,category,title,summary,cover,body_md,views,created_at,updated_at,published_at " +
      "FROM articles WHERE id=?1 AND status='published'"
    ).bind(id).first();
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
