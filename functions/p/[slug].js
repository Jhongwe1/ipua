// GET /p/<slug> — 自訂頁面（例 /p/about）。內容存 D1 pages 表，用 /api/admin/pages 建立與編輯。
// 只顯示已發佈（published）的頁面；草稿或不存在 → 404。
// 外殼與文章頁同一套（pageShell）：☰ 側邊欄、日夜、EN/中、SEO 標籤都一致。
import { marked } from "../../lib/vendor/marked.mjs";
import { CANON, esc, html, timeAgo, pageShell, getChrome, SLUG_RE } from "../../lib/site.js";

const MD_OPTS = { gfm: true, breaks: true, async: false };

export async function onRequestGet({ env, params }) {
  const slug = String(params.slug || "").toLowerCase();
  const chromeP = getChrome(env);

  let row = null;
  if (SLUG_RE.test(slug) && env.DB) {
    try {
      row = await env.DB.prepare(
        "SELECT * FROM pages WHERE slug=?1 AND status='published'"
      ).bind(slug).first();
    } catch (e) { /* 資料表尚未建立 → 當作找不到 */ }
  }
  const chrome = await chromeP;
  if (!row) return notFound(chrome);

  const canonical = CANON + "/p/" + row.slug;
  // 內文圖片 lazy 載入（與文章頁同規則）
  const bodyHtml = marked.parse(row.body_md || "", MD_OPTS).replace(/<img /g, '<img loading="lazy" ');

  const headExtra =
    '<meta property="og:type" content="website">' +
    '<meta property="og:site_name" content="' + esc(chrome.brand) + '">' +
    '<meta property="og:title" content="' + esc(row.title) + '">' +
    '<meta property="og:description" content="' + esc(row.summary || "") + '">' +
    '<meta property="og:url" content="' + esc(canonical) + '">\n';

  const body =
    '<article class="art">\n' +
    '<h1 class="t">' + esc(row.title) + "</h1>\n" +
    '<div class="ameta">' + timeAgo(row.updated_at) + "</div>\n" +
    '<div class="prose">\n' + bodyHtml + "\n</div>\n" +
    "</article>";

  return html(pageShell({
    title: row.title,
    desc: row.summary || row.title,
    canonical: canonical,
    activePath: "/p/" + row.slug,   // 若選單有掛這頁的連結會標成 active
    chrome: chrome,
    h1: '<a href="/">' + esc(chrome.brand) + "</a>",
    headExtra: headExtra,
    body: body
  }));
}

function notFound(chrome) {
  return html(pageShell({
    title: "找不到頁面",
    desc: "這個頁面不存在或已下架。",
    chrome: chrome,
    h1: '<a href="/">' + esc(chrome.brand) + "</a>",
    noindex: true,
    body: '<div class="empty" data-i18n="empty.404">找不到這篇內容 — 可能已下架或網址有誤。</div>' +
      '<div class="backrow" style="text-align:center"><a class="ctrl" href="/">← 回首頁</a></div>'
  }), 404);
}
