// GET /sitemap — 給搜尋引擎的全站網址清單（public/robots.txt 裡有指路）。
// 固定頁面＋所有已發佈的文章＋已發佈的自訂頁面（/p/<slug>）；lastmod 用最後更新時間。
import { CANON, CATS } from "../lib/site.js";

export async function onRequestGet({ env }) {
  let rows = [], pageRows = [];
  try {
    const res = await env.DB.prepare(
      "SELECT id,category,updated_at FROM articles WHERE status='published' " +
      "ORDER BY published_at DESC, id DESC LIMIT 5000"
    ).all();
    rows = res.results || [];
  } catch (e) {}
  try {
    const res = await env.DB.prepare(
      "SELECT slug,updated_at FROM pages WHERE status='published' ORDER BY slug LIMIT 500"
    ).all();
    pageRows = res.results || [];
  } catch (e) { /* pages 表尚未建立時略過 */ }

  const urls = [];
  ["/", "/ip", "/ua", "/news", "/articles"].forEach(function (p) {
    urls.push("  <url><loc>" + CANON + p + "</loc></url>");
  });
  rows.forEach(function (r) {
    const cat = CATS[r.category] || CATS.news;
    const lastmod = (r.updated_at || "").slice(0, 10);
    urls.push("  <url><loc>" + CANON + cat.path + "/" + r.id + "</loc>" +
      (lastmod ? "<lastmod>" + lastmod + "</lastmod>" : "") + "</url>");
  });
  pageRows.forEach(function (r) {
    const lastmod = (r.updated_at || "").slice(0, 10);
    urls.push("  <url><loc>" + CANON + "/p/" + r.slug + "</loc>" +
      (lastmod ? "<lastmod>" + lastmod + "</lastmod>" : "") + "</url>");
  });

  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls.join("\n") + "\n</urlset>\n";

  return new Response(xml, {
    headers: {
      "content-type": "application/xml; charset=utf-8",
      "cache-control": "public, max-age=600"
    }
  });
}
