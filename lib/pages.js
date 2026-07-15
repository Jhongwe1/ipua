// lib/pages.js — 列表頁與文章頁的實際內容（functions/news、functions/articles 共用）。
// 列表排版仿 antutu 新聞列表：左縮圖、右標題＋兩行摘要＋「N 小時前・瀏覽數」，底部頁碼。
// 文章頁由伺服器把 Markdown 轉成完整 HTML 再輸出 — 搜尋引擎收錄與 LINE/FB 分享預覽全靠這個。

import { marked } from "./vendor/marked.mjs";
import { sanitizeHtml } from "./sanitize.js";
import { siteOrigin, CATS, esc, html, timeAgo, fmtDate, pageShell, EYE } from "./site.js";
import { getChromeFor } from "./chrome.js";

const PER_PAGE = 10;
// breaks:true → 在後台按一次 Enter 就是換行（對一般寫作直覺）；gfm → 支援表格、刪除線等
const MD_OPTS = { gfm: true, breaks: true, async: false };

/* ===== 列表頁：/news、/articles（?p=2 換頁） ===== */
export async function listPage(context, catKey) {
  const { request, env } = context;
  const cat = CATS[catKey];
  const url = new URL(request.url);
  let p = parseInt(url.searchParams.get("p"), 10);
  if (!p || p < 1 || p > 100000) p = 1;

  const chromeP = getChromeFor(env, request);   // 選單＋站名（依身分過濾），與文章查詢並行
  let rows = [], total = 0;
  try {
    const res = await env.DB.batch([
      env.DB.prepare(
        "SELECT id,title,summary,cover,views,published_at FROM articles " +
        "WHERE status='published' AND category=?1 " +
        "ORDER BY published_at DESC, id DESC LIMIT " + PER_PAGE + " OFFSET " + (p - 1) * PER_PAGE
      ).bind(catKey),
      env.DB.prepare("SELECT COUNT(*) AS c FROM articles WHERE status='published' AND category=?1").bind(catKey)
    ]);
    rows = res[0].results || [];
    total = (res[1].results[0] || {}).c || 0;
  } catch (e) { /* 資料表尚未建立時顯示空列表，不讓整頁掛掉 */ }

  const pages = Math.max(1, Math.ceil(total / PER_PAGE));
  const items = rows.map(function (r) { return itemHtml(cat, r); }).join("\n");
  const body =
    '<section class="list">\n' +
    (items || '<div class="empty" data-i18n="empty.list">目前還沒有內容，敬請期待。</div>') +
    "\n</section>\n" + pagerHtml(cat.path, p, pages);

  const chrome = (await chromeP).chrome;
  return html(pageShell({
    title: cat.label + (p > 1 ? "（第 " + p + " 頁）" : ""),
    tkey: cat.tkey,
    desc: chrome.brand + " " + cat.label + "頻道 — " + cat.desc + "。",
    canonical: siteOrigin(env, request) + cat.path + (p > 1 ? "?p=" + p : ""),
    activePath: cat.path,
    chrome: chrome,
    h1: '<span data-i18n="' + cat.tkey + '">' + cat.label + "</span>",
    body: body
  }));
}

function itemHtml(cat, r) {
  const href = cat.path + "/" + r.id;
  const thumb = r.cover
    ? '<span class="thumb"><img src="' + esc(r.cover) + '" alt="' + esc(r.title) + '" loading="lazy"></span>'
    : '<span class="thumb" aria-hidden="true">📰</span>';
  return '<a class="item" href="' + href + '">' + thumb +
    '<span class="it"><h2>' + esc(r.title) + "</h2>" +
    (r.summary ? "<p>" + esc(r.summary) + "</p>" : "") +
    '<span class="meta">' + timeAgo(r.published_at) +
    '<span class="views">' + EYE + " " + (r.views || 0) + "</span></span></span></a>";
}

// 頁碼：永遠顯示 1 與最後頁，目前頁前後各一頁，中間用 … 略過（仿 antutu 底部分頁）
function pagerHtml(base, p, pages) {
  if (pages <= 1) return "";
  const link = function (n, text, key) {
    const href = base + (n > 1 ? "?p=" + n : "");
    return n === p && !text
      ? '<span class="cur">' + n + "</span>"
      : '<a href="' + href + '"' + (key ? ' data-i18n="' + key + '"' : "") + ">" + (text || n) + "</a>";
  };
  const want = [1, 2, p - 1, p, p + 1, pages - 1, pages].filter(function (n) { return n >= 1 && n <= pages; });
  const ns = Array.from(new Set(want)).sort(function (a, b) { return a - b; });
  let mid = "", prev = 0;
  ns.forEach(function (n) {
    if (n - prev > 1) mid += '<span class="gap">…</span>';
    mid += link(n); prev = n;
  });
  return '<nav class="pager" aria-label="分頁">' +
    (p > 1 ? link(p - 1, "‹ 上一頁", "pg.prev") : "") + mid +
    (p < pages ? link(p + 1, "下一頁 ›", "pg.next") : "") + "</nav>";
}

/* ===== 文章頁：/news/12、/articles/34 ===== */
export async function articlePage(context, catKey) {
  const { request, env, params } = context;
  const cat = CATS[catKey];
  const id = parseInt(params.id, 10);

  const chromeP = getChromeFor(env, request);   // 選單＋站名（依身分過濾），與文章查詢並行
  let row = null;
  if (id > 0 && env.DB) {
    try {
      row = await env.DB.prepare(
        "SELECT * FROM articles WHERE id=?1 AND category=?2 AND status='published'"
      ).bind(id, catKey).first();
    } catch (e) {}
  }
  if (!row) return notFound(cat, (await chromeP).chrome);

  // 瀏覽數 +1：背景執行、失敗不影響頁面；跳過預先抓取與常見機器人，數字比較接近真人
  try {
    const ua = request.headers.get("user-agent") || "";
    const purpose = (request.headers.get("sec-purpose") || request.headers.get("purpose") || "").toLowerCase();
    const isBot = /bot|crawl|spider|preview|fetch|curl|wget|python|http/i.test(ua);
    if (request.method === "GET" && !isBot && purpose.indexOf("prefetch") < 0 && purpose.indexOf("preview") < 0) {
      context.waitUntil(
        env.DB.prepare("UPDATE articles SET views=views+1 WHERE id=?1").bind(id).run().catch(function () {})
      );
    }
  } catch (e) {}

  // 上一篇（較舊）／下一篇（較新）：同分類、已發佈，依發佈時間排
  let older = null, newer = null;
  try {
    const nav = await env.DB.batch([
      env.DB.prepare(
        "SELECT id,title FROM articles WHERE status='published' AND category=?1 " +
        "AND (published_at < ?2 OR (published_at = ?2 AND id < ?3)) " +
        "ORDER BY published_at DESC, id DESC LIMIT 1"
      ).bind(catKey, row.published_at, row.id),
      env.DB.prepare(
        "SELECT id,title FROM articles WHERE status='published' AND category=?1 " +
        "AND (published_at > ?2 OR (published_at = ?2 AND id > ?3)) " +
        "ORDER BY published_at ASC, id ASC LIMIT 1"
      ).bind(catKey, row.published_at, row.id)
    ]);
    older = (nav[0].results || [])[0] || null;
    newer = (nav[1].results || [])[0] || null;
  } catch (e) {}

  const chrome = (await chromeP).chrome;
  const origin = siteOrigin(env, request);
  const canonical = origin + cat.path + "/" + row.id;
  const coverAbs = row.cover ? (row.cover.charAt(0) === "/" ? origin + row.cover : row.cover) : "";
  // Markdown → HTML 後過白名單消毒（marked 會放行原始 HTML — 見 lib/sanitize.js）；
  // 內文圖片 lazy 載入：捲到才載，文長圖多時省流量（封面不 lazy，它是第一眼內容）
  const bodyHtml = sanitizeHtml(marked.parse(row.body_md || "", MD_OPTS)).replace(/<img /g, '<img loading="lazy" ');

  // 分享預覽（og:*）＋搜尋引擎結構化資料（JSON-LD）；</ 跳脫避免提早關閉 script
  const ld = JSON.stringify({
    "@context": "https://schema.org",
    "@type": catKey === "news" ? "NewsArticle" : "Article",
    "headline": row.title,
    "description": row.summary || undefined,
    "image": coverAbs ? [coverAbs] : undefined,
    "datePublished": row.published_at,
    "dateModified": row.updated_at,
    "mainEntityOfPage": canonical,
    "author": { "@type": "Organization", "name": chrome.brand },
    "publisher": { "@type": "Organization", "name": chrome.brand }
  }).replace(/</g, "\\u003c");
  const headExtra =
    '<meta property="og:type" content="article">' +
    '<meta property="og:site_name" content="' + esc(chrome.brand) + '">' +
    '<meta property="og:title" content="' + esc(row.title) + '">' +
    '<meta property="og:description" content="' + esc(row.summary || "") + '">' +
    '<meta property="og:url" content="' + esc(canonical) + '">' +
    (coverAbs ? '<meta property="og:image" content="' + esc(coverAbs) + '"><meta name="twitter:card" content="summary_large_image">' : "") +
    '<meta property="article:published_time" content="' + esc(row.published_at || "") + '">' +
    '<script type="application/ld+json">' + ld + "</scr" + "ipt>\n";

  let anav = "";
  if (older || newer) {
    anav = '<nav class="anav">' +
      (older
        ? '<a href="' + cat.path + "/" + older.id + '"><span class="lbl" data-i18n="an.prev">上一篇</span><span class="ttl">' + esc(older.title) + "</span></a>"
        : "<span></span>") +
      (newer
        ? '<a class="nx" href="' + cat.path + "/" + newer.id + '"><span class="lbl" data-i18n="an.next">下一篇</span><span class="ttl">' + esc(newer.title) + "</span></a>"
        : "") +
      "</nav>";
  }

  const body =
    '<article class="art">\n' +
    '<h1 class="t">' + esc(row.title) + "</h1>\n" +
    '<div class="ameta"><span data-i18n="' + cat.tkey + '">' + cat.label + "</span>" + timeAgo(row.published_at) +
    '<span class="views">' + EYE + " " + ((row.views || 0) + 1) + "</span></div>\n" +
    (row.cover ? '<img class="cover" src="' + esc(row.cover) + '" alt="' + esc(row.title) + '">\n' : "") +
    '<div class="prose">\n' + bodyHtml + "\n</div>\n" +
    anav +
    '<div class="backrow"><a class="ctrl" href="' + cat.path + '" data-i18n="back.' + cat.key + '">← 回' + cat.label + "列表</a></div>\n" +
    "</article>";

  return html(pageShell({
    title: row.title,
    desc: row.summary || row.title,
    canonical: canonical,
    activePath: cat.path,
    chrome: chrome,
    h1: '<a href="' + cat.path + '" data-i18n="' + cat.tkey + '">' + cat.label + "</a>",
    headExtra: headExtra,
    body: body
  }));
}

function notFound(cat, chrome) {
  return html(pageShell({
    title: "找不到內容",
    desc: "這篇內容不存在或已下架。",
    activePath: cat ? cat.path : "",
    chrome: chrome,
    h1: cat ? '<a href="' + cat.path + '" data-i18n="' + cat.tkey + '">' + cat.label + "</a>" : "404",
    noindex: true,
    body: '<div class="empty" data-i18n="empty.404">找不到這篇內容 — 可能已下架或網址有誤。</div>' +
      '<div class="backrow" style="text-align:center"><a class="ctrl" href="' + (cat ? cat.path : "/") + '"' +
      (cat ? ' data-i18n="back.' + cat.key + '"' : "") + ">← 回" + (cat ? cat.label + "列表" : "首頁") + "</a></div>"
  }), 404);
}
