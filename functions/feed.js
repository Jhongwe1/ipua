// GET /feed — RSS 訂閱源（新聞＋文章合流，最新 20 篇）。
// RSS 閱讀器與部分搜尋服務會定期來抓，這是小型新聞站的標準配備。
import { siteOrigin, CATS, esc, getChrome } from "../lib/site.js";

export async function onRequestGet({ request, env }) {
  const CANON = siteOrigin(env, request);
  const chrome = await getChrome(env, request);   // 站名（編輯模式可改，存 settings 表）
  let rows = [];
  try {
    const res = await env.DB.prepare(
      "SELECT id,category,title,summary,published_at,updated_at FROM articles " +
      "WHERE status='published' ORDER BY published_at DESC, id DESC LIMIT 20"
    ).all();
    rows = res.results || [];
  } catch (e) {}

  const items = rows.map(function (r) {
    const cat = CATS[r.category] || CATS.news;
    const link = CANON + cat.path + "/" + r.id;
    const pub = new Date(r.published_at || r.updated_at || Date.now()).toUTCString();
    return "  <item>\n" +
      "    <title>" + esc(r.title) + "</title>\n" +
      "    <link>" + link + "</link>\n" +
      '    <guid isPermaLink="true">' + link + "</guid>\n" +
      "    <pubDate>" + pub + "</pubDate>\n" +
      "    <category>" + cat.label + "</category>\n" +
      "    <description>" + esc(r.summary || "") + "</description>\n" +
      "  </item>";
  }).join("\n");

  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<rss version="2.0">\n<channel>\n' +
    "  <title>" + esc(chrome.brand) + " · 新聞與文章</title>\n" +
    "  <link>" + CANON + "/news</link>\n" +
    "  <description>" + esc(chrome.brand) + " 的最新新聞與文章</description>\n" +
    "  <language>zh-hant</language>\n" +
    items + "\n</channel>\n</rss>\n";

  return new Response(xml, {
    headers: {
      "content-type": "application/rss+xml; charset=utf-8",
      "cache-control": "public, max-age=600"
    }
  });
}
