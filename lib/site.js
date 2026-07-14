// lib/site.js — 新聞／文章功能的共用程式，給 functions/ 底下的路由 import。
// 部署時 wrangler 會把這個資料夾打包進 Functions；lib/ 在 public/ 之外，不會被當成靜態檔上傳。
// 頁面外殼刻意沿用主站 index.html 的設計語言：同一組 CSS 變數、☰ 側邊欄、日夜主題。
// 外殼（選單、頁首、頁尾、相對時間等「框架」）支援中英切換 — 伺服器先輸出中文，
// 瀏覽器端依 localStorage `ipua-lang`（與主站共用）或裝置語言套用翻譯；文章內容本身不翻譯。

export const CANON = "https://uaip.cc.cd";   // SEO 用的正式網址（canonical、og、sitemap、RSS）
export const BRAND = "uaip.cc.cd";           // 預設站名（正式站名可在編輯模式→網站名稱改，存 settings 表）

// 內建預設選單：menu 資料表是空的時候用這一份（也是「還原預設」的內容）。
// 站長在編輯模式改過選單後，以資料表內容為準。
export const DEFAULT_MENU = [
  { kind: "section", label: "服務",       label_en: "Services",  url: "" },
  { kind: "link",    label: "LLM playground", label_en: "LLM playground", url: "/playground" },
  { kind: "link",    label: "API 中轉站", label_en: "API relay", url: "/relay" },
  { kind: "link",    label: "VPN",        label_en: "VPN",       url: "/vpn" },
  { kind: "section", label: "工具",       label_en: "Tools",     url: "" },
  { kind: "link",    label: "IP 查詢",    label_en: "IP Lookup", url: "/ip" },
  { kind: "link",    label: "UA 查詢",    label_en: "UA Lookup", url: "/ua" },
  { kind: "section", label: "內容",       label_en: "Content",   url: "" },
  { kind: "link",    label: "新聞",       label_en: "News",      url: "/news" },
  { kind: "link",    label: "文章",       label_en: "Articles",  url: "/articles" }
];

// 站台外觀資料（側邊欄選單＋站名）：一次 D1 batch 讀回。
// 資料表還沒建立、查詢失敗都退回內建預設 — 資料庫出狀況網站外殼照常運作。
export async function getChrome(env) {
  const chrome = { brand: BRAND, menu: DEFAULT_MENU, custom: false };
  if (!env || !env.DB) return chrome;
  try {
    const res = await env.DB.batch([
      env.DB.prepare("SELECT kind,label,label_en,url FROM menu ORDER BY pos, id"),
      env.DB.prepare("SELECT v FROM settings WHERE k='brand'")
    ]);
    const rows = res[0].results || [];
    if (rows.length) { chrome.menu = rows; chrome.custom = true; }
    const b = (res[1].results || [])[0];
    if (b && b.v) chrome.brand = b.v;
  } catch (e) { /* 表未建立／查詢失敗 → 預設 */ }
  return chrome;
}

export const CATS = {
  news:    { key: "news",    path: "/news",     label: "新聞", tkey: "cat.news",    desc: "最新消息與快訊" },
  article: { key: "article", path: "/articles", label: "文章", tkey: "cat.article", desc: "專題、心得與長文" }
};

// 自訂頁面（/p/<slug>）的網址代稱規則：小寫英數與連字號、頭尾不能是連字號、最長 64 字。
export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

// 與 functions/api/logs.js 相同的站長驗證：Authorization: Bearer <LOGS_TOKEN>。
// 金鑰沒設定時正式站一律 401；本機開發（localhost）免驗證，方便測試。
export function authed(request, env, url) {
  const auth = request.headers.get("authorization") || "";
  const token = auth.indexOf("Bearer ") === 0 ? auth.slice(7).trim() : "";
  if (env.LOGS_TOKEN) return token === env.LOGS_TOKEN;
  return url.hostname === "localhost" || url.hostname === "127.0.0.1";
}

export function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}

export function html(body, status) {
  return new Response(body, {
    status: status || 200,
    headers: { "content-type": "text/html; charset=utf-8" }
  });
}

// UTC ISO → 台灣日期 YYYY-MM-DD（台灣固定 UTC+8，無日光節約）
export function fmtDate(iso) {
  const t = Date.parse(iso || "");
  if (isNaN(t)) return "";
  return new Date(t + 8 * 3600e3).toISOString().slice(0, 10);
}

// 伺服器先放絕對日期（沒有 JS 的環境與搜尋引擎都看得懂），
// 瀏覽器端外殼腳本再把它換算成「3 小時前 / 3 hr ago」這種相對時間。
export function timeAgo(iso) {
  return '<time datetime="' + esc(iso) + '" data-ts="' + esc(iso) + '">' + fmtDate(iso) + "</time>";
}

// 眼睛小圖示（瀏覽數）
export const EYE = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>';

// 側邊欄選單 HTML：section 是分類標題、link 是連結；自訂英文名放 data-en，
// 由外殼腳本依語言切換（沒英文名就一直顯示中文）。activePath 命中的連結加 active。
function menuHtml(menu, activePath) {
  return menu.map(function (it) {
    const en = it.label_en ? ' data-en="' + esc(it.label_en) + '"' : "";
    if (it.kind === "section") return '    <div class="sb-sec"' + en + ">" + esc(it.label) + "</div>";
    const act = activePath && it.url === activePath ? " active" : "";
    return '    <a class="sb-link' + act + '" href="' + esc(it.url) + '"' + en + ">" + esc(it.label) + "</a>";
  }).join("\n");
}

/* 頁面外殼：o = {
     title      分頁標題（會自動加上「 · 站名」）
     tkey       分頁標題的翻譯 key（列表頁用；文章頁標題不翻譯就不給）
     desc       meta description
     canonical  正式網址（絕對網址）
     activePath 側邊欄目前頁面的路徑（例 "/news"；選單連結相同者標 active）
     chrome     getChrome(env) 的結果（站名＋選單）；不給就用內建預設
     h1         頁首左上的大標（HTML，可含連結與 data-i18n）
     headExtra  額外塞進 <head> 的東西（og、JSON-LD…）
     body       主要內容 HTML
     noindex    true = 不讓搜尋引擎收錄
   } */
export function pageShell(o) {
  const brand = (o.chrome && o.chrome.brand) || BRAND;
  const menu = (o.chrome && o.chrome.menu) || DEFAULT_MENU;
  return '<!DOCTYPE html>\n<html lang="zh-Hant" data-theme="light">\n<head>\n' +
    '<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
    "<title>" + esc(o.title) + " · " + esc(brand) + "</title>\n" +
    '<meta name="description" content="' + esc(o.desc || "") + '">\n' +
    (o.noindex ? '<meta name="robots" content="noindex,nofollow">\n' : "") +
    (o.canonical ? '<link rel="canonical" href="' + esc(o.canonical) + '">\n' : "") +
    '<link rel="alternate" type="application/rss+xml" title="' + esc(brand) + ' RSS" href="/feed">\n' +
    '<meta name="theme-color" media="(prefers-color-scheme: light)" content="#ffffff">\n' +
    '<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#0b0b0b">\n' +
    "<link rel=\"icon\" href=\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%F0%9F%8C%90%3C/text%3E%3C/svg%3E\">\n" +
    (o.headExtra || "") +
    "<style>" + SHELL_CSS + "</style>\n</head>\n<body>\n" +
    '<button id="menuBtn" class="ctrl" aria-label="選單" data-i18n-aria="sb.title" aria-expanded="false" aria-controls="sidebar">' +
    '<svg width="16" height="14" viewBox="0 0 16 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M1 1h14M1 7h14M1 13h14"/></svg></button>\n' +
    '<div id="sbOverlay" class="sb-overlay"></div>\n' +
    '<aside id="sidebar" class="sb" aria-hidden="true" inert>\n' +
    '  <div class="sb-head"><span data-i18n="sb.title">選單</span><button id="sbClose" class="ctrl" aria-label="關閉">✕</button></div>\n' +
    // #sbMenu＝選單本體（資料庫或預設）；#sbAdmin＝站長區容器，由 adminbar.js 動態長出，
    // 分開兩個容器是為了讓選單重繪不會把站長區洗掉。
    '  <nav>\n  <div id="sbMenu">\n' + menuHtml(menu, o.activePath) + '\n  </div>\n  <div id="sbAdmin"></div>\n  </nav>\n</aside>\n' +
    '<div class="wrap">\n' +
    "  <header><h1>" + o.h1 + '</h1><div class="ctrls">' +
    '<button id="langToggle" class="ctrl" title="Language / 語言">EN</button>' +
    '<button id="themeToggle" class="ctrl" title="Day / Night">☾</button></div></header>\n' +
    o.body + "\n" +
    // foot.tool 連到 /ip：根網址 / 已改跳 LLM playground（public/_redirects），工具入口改走 /ip
    '  <footer><a href="/news" data-i18n="cat.news">新聞</a> · <a href="/articles" data-i18n="cat.article">文章</a> · <a href="/ip" data-i18n="foot.tool">IP·UA 查詢</a> · <a href="/feed" data-i18n="foot.rss">RSS 訂閱</a></footer>\n' +
    "</div>\n<script>var __TKEY=" + JSON.stringify(o.tkey || null) + ",__BRAND=" + JSON.stringify(brand) + ";" + SHELL_JS + "</script>\n" +
    // ?v= 版本參數：assets 有 4 小時邊緣/瀏覽器快取，改了 account.js/adminbar.js 要一起把這裡的版本號調大
    '<script src="/assets/account.js?v=20260714c"></script>\n</body>\n</html>\n';
}

// ===== 外殼樣式：變數與元件抄自主站 index.html，後面加上列表／文章頁專用樣式 =====
const SHELL_CSS = `
  *{box-sizing:border-box;margin:0;padding:0}
  :root{--bg:#ffffff;--fg:#111111;--muted:#7a7a7a;--sub:#a0a0a0;--line:#e6e6e6;--line2:#111111;--card:#ffffff;--accent:#111111;--accent-fg:#ffffff;--field:#fafafa;color-scheme:light}
  [data-theme="dark"]{--bg:#0b0b0b;--fg:#f4f4f4;--muted:#8f8f8f;--sub:#6b6b6b;--line:#262626;--line2:#f4f4f4;--card:#131313;--accent:#f4f4f4;--accent-fg:#0b0b0b;--field:#181818;color-scheme:dark}
  html,body{background:var(--bg);color:var(--fg)}
  body{font-family:-apple-system,"Segoe UI","Microsoft JhengHei",system-ui,"PingFang TC",sans-serif;line-height:1.55;-webkit-font-smoothing:antialiased;padding:26px 16px 56px;transition:background .25s,color .25s}
  .wrap{max-width:720px;margin:0 auto}
  header{display:flex;align-items:center;justify-content:space-between;margin-bottom:18px;gap:10px}
  h1{font-size:20px;font-weight:700;letter-spacing:.03em}
  h1 a{color:var(--fg);text-decoration:none}
  h1 a:hover{text-decoration:underline}
  .ctrls{display:flex;gap:8px;flex:0 0 auto}
  .ctrl{height:38px;min-width:38px;padding:0 13px;border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:20px;cursor:pointer;font-size:13px;font-weight:600;line-height:1;font-family:inherit;transition:.15s;display:inline-flex;align-items:center;justify-content:center;text-decoration:none}
  .ctrl:hover{border-color:var(--line2)}
  #themeToggle{width:38px;padding:0;font-size:15px}
  #menuBtn{position:fixed;top:14px;left:14px;z-index:50}
  #menuBtn svg{display:block}
  /* 窄螢幕：標題讓位給 ☰，且 ☰ 下移到與標題列（右側圓鈕）同一水平線（body 上留白 26px） */
  @media(max-width:839.98px){header{padding-left:52px}#menuBtn{top:26px}}
  .sb-overlay{position:fixed;inset:0;background:rgba(0,0,0,.45);opacity:0;visibility:hidden;transition:opacity .2s,visibility .2s;z-index:60}
  .sb-overlay.show{opacity:1;visibility:visible}
  .sb{position:fixed;top:0;left:0;bottom:0;width:264px;max-width:82vw;background:var(--card);border-right:1px solid var(--line);z-index:61;transform:translateX(-103%);transition:transform .22s ease;display:flex;flex-direction:column}
  .sb.open{transform:none;box-shadow:0 0 42px rgba(0,0,0,.25)}
  .sb-head{display:flex;align-items:center;justify-content:space-between;padding:13px 13px 11px 20px;font-size:15px;font-weight:700;border-bottom:1px solid var(--line)}
  #sbClose{width:34px;height:34px;min-width:34px;padding:0;font-size:13px;border-radius:17px}
  .sb nav{padding:6px 10px 22px;overflow-y:auto;flex:1}
  .sb-sec{font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);padding:16px 10px 7px}
  .sb-link{display:block;padding:10px;border-radius:8px;color:var(--fg);text-decoration:none;font-size:14px;font-weight:600;transition:.15s}
  .sb-link:hover{background:var(--field)}
  .sb-link.active{background:var(--accent);color:var(--accent-fg)}
  footer{margin-top:34px;text-align:center;color:var(--sub);font-size:11px;line-height:1.8}
  footer a{color:var(--muted);text-decoration:none}
  footer a:hover{text-decoration:underline}
  /* ===== 列表（排版仿 antutu：左縮圖、右標題＋兩行摘要＋時間/瀏覽數） ===== */
  .list{border-top:1px solid var(--line)}
  .item{display:flex;gap:18px;padding:20px 0;border-bottom:1px solid var(--line);text-decoration:none;color:var(--fg)}
  .thumb{flex:0 0 228px;aspect-ratio:5/3;border-radius:10px;overflow:hidden;background:var(--field);border:1px solid var(--line);display:flex;align-items:center;justify-content:center;font-size:34px}
  .thumb img{width:100%;height:100%;object-fit:cover;display:block}
  .it{flex:1;min-width:0;display:flex;flex-direction:column}
  .it h2{font-size:17.5px;line-height:1.5;font-weight:700;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
  .item:hover h2{text-decoration:underline}
  .it p{margin-top:7px;font-size:13.5px;color:var(--muted);line-height:1.65;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
  .meta{margin-top:auto;padding-top:8px;font-size:12.5px;color:var(--sub);display:flex;gap:16px;align-items:center}
  .meta .views{display:inline-flex;align-items:center;gap:5px}
  .empty{padding:44px 0;text-align:center;color:var(--muted);font-size:14px;border-bottom:1px solid var(--line)}
  @media(max-width:560px){
    .item{gap:12px;padding:14px 0}
    .thumb{flex-basis:124px;aspect-ratio:3/2;border-radius:8px;font-size:22px}
    .it h2{font-size:15px}
    .it p{display:none}
    .meta{padding-top:4px;font-size:12px}
  }
  /* ===== 頁碼分頁 ===== */
  .pager{display:flex;gap:8px;justify-content:center;align-items:center;margin:26px 0 4px;flex-wrap:wrap}
  .pager a,.pager .cur,.pager .gap{min-width:36px;height:36px;padding:0 12px;border:1px solid var(--line);border-radius:9px;display:inline-flex;align-items:center;justify-content:center;font-size:13.5px;font-weight:600;text-decoration:none;color:var(--fg)}
  .pager a:hover{border-color:var(--line2)}
  .pager .cur{background:var(--accent);color:var(--accent-fg);border-color:var(--line2)}
  .pager .gap{border:0;color:var(--sub);min-width:auto;padding:0 2px}
  /* ===== 文章頁 ===== */
  .art h1.t{font-size:24px;line-height:1.45;font-weight:700;margin:2px 0 12px;letter-spacing:0}
  .ameta{color:var(--sub);font-size:13px;display:flex;gap:14px;align-items:center;flex-wrap:wrap;margin-bottom:18px}
  .ameta .views{display:inline-flex;align-items:center;gap:5px}
  .cover{width:100%;border-radius:11px;border:1px solid var(--line);display:block;margin-bottom:20px}
  .prose{font-size:16px;line-height:1.95;overflow-wrap:anywhere}
  .prose p{margin:0 0 1.1em}
  .prose h2{font-size:20px;line-height:1.5;margin:1.5em 0 .65em}
  .prose h3{font-size:17.5px;margin:1.3em 0 .55em}
  .prose h4{font-size:16px;margin:1.2em 0 .5em}
  .prose img{max-width:100%;height:auto;border-radius:10px;display:block;margin:18px auto}
  .prose a{color:var(--fg)}
  .prose ul,.prose ol{padding-left:1.7em;margin:0 0 1.1em}
  .prose li{margin:.28em 0}
  .prose blockquote{border-left:3px solid var(--line2);padding:2px 0 2px 14px;color:var(--muted);margin:0 0 1.1em}
  .prose code{font-family:ui-monospace,Menlo,Consolas,monospace;background:var(--field);border:1px solid var(--line);border-radius:5px;padding:1px 6px;font-size:.88em}
  .prose pre{background:var(--field);border:1px solid var(--line);border-radius:10px;padding:14px;overflow-x:auto;margin:0 0 1.1em;line-height:1.6}
  .prose pre code{border:0;background:none;padding:0}
  .prose hr{border:0;border-top:1px solid var(--line);margin:1.6em 0}
  .prose table{border-collapse:collapse;margin:0 0 1.1em;max-width:100%;display:block;overflow-x:auto}
  .prose th,.prose td{border:1px solid var(--line);padding:6px 12px;font-size:14px}
  /* 上一篇／下一篇 */
  .anav{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:28px}
  .anav a{border:1px solid var(--line);border-radius:11px;padding:12px 14px;text-decoration:none;color:var(--fg);min-width:0;transition:.15s}
  .anav a:hover{border-color:var(--line2)}
  .anav a.nx{text-align:right}
  .anav .lbl{display:block;font-size:11px;font-weight:700;letter-spacing:.08em;color:var(--muted);margin-bottom:4px;text-transform:uppercase}
  .anav .ttl{display:block;font-size:14px;font-weight:600;line-height:1.5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  @media(max-width:560px){.anav{grid-template-columns:1fr}.anav a.nx{text-align:left}}
  .backrow{margin-top:16px}
  @media(max-width:480px){h1{font-size:17px}body{padding:20px 13px 48px}#menuBtn{top:20px}.art h1.t{font-size:20px}.prose{font-size:15.5px}}
`;

// ===== 管理頁共用樣式（/logs、/admin 的卡片、表單、表格元件；接在 SHELL_CSS 之後使用） =====
export const ADMIN_CSS = `
  .card{border:1px solid var(--line);border-radius:11px;padding:14px 16px;margin-bottom:14px;background:var(--card)}
  .card-title{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);padding-bottom:9px;margin-bottom:9px;border-bottom:1px solid var(--line)}
  .hint{font-size:12.5px;color:var(--muted);margin:4px 0 10px}
  .error{border:1px solid var(--line2);border-radius:8px;padding:11px 14px;margin-top:12px;font-size:13px}
  .hidden{display:none!important}
  .mono{font-family:ui-monospace,"SFMono-Regular",Menlo,Consolas,"Courier New",monospace}
  .query{display:flex;gap:8px;margin-bottom:14px}
  input[type=text],input[type=password],select,textarea{
    width:100%;border:1px solid var(--line);background:var(--field);color:var(--fg);
    border-radius:8px;padding:11px 12px;font-size:14px;font-family:inherit;outline:none;transition:.15s}
  .query input{flex:1}
  input:focus,select:focus,textarea:focus{border-color:var(--line2)}
  textarea{resize:vertical;line-height:1.7}
  button[type=submit],.primary{
    border:1px solid var(--line2);background:var(--accent);color:var(--accent-fg);
    border-radius:8px;padding:11px 22px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit;white-space:nowrap}
  .ghost{
    border:1px solid var(--line);background:transparent;color:var(--fg);border-radius:8px;
    padding:11px 16px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit;white-space:nowrap;transition:.15s;
    text-decoration:none;display:inline-flex;align-items:center;gap:6px}
  .ghost:hover{border-color:var(--line2)}
  .danger:hover{border-color:#c33;color:#c33}
  button:disabled{opacity:.5;cursor:default}
  .toolbar{display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap;align-items:center}
  .toolbar .sp{flex:1}
  .tbl-card{padding:0;overflow:hidden}
  .tbl-wrap{overflow-x:auto}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th{text-align:left;font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;
     padding:10px 12px;border-bottom:1px solid var(--line);white-space:nowrap;background:var(--card)}
  td{padding:10px 12px;border-bottom:1px dashed var(--line)}
  tbody tr:last-child td{border-bottom:0}
  td.nowrap{white-space:nowrap}
  .tbl-empty{padding:22px;text-align:center;color:var(--muted);font-size:13px}
`;

// ===== 外殼腳本：框架中英切換（與主站共用 ipua-lang）、主題、側邊欄、站長捷徑、相對時間 =====
const SHELL_JS = `
(function(){
  "use strict";
  /* --- 框架翻譯字典（只翻框架，文章內容不翻） --- */
  var I18N={
    zh:{"sb.title":"選單","sb.content":"內容","sb.tools":"工具","sb.admin":"站長","sb.manage":"文章管理","sb.logs":"訪客紀錄",
        "cat.news":"新聞","cat.article":"文章","tab.ip":"IP 查詢","tab.ua":"UA 查詢",
        "foot.tool":"IP·UA 查詢","foot.rss":"RSS 訂閱",
        "page.relay":"API 中轉站","page.vpn":"VPN","page.members":"成員管理","page.playground":"LLM playground",
        "back.news":"← 回新聞列表","back.article":"← 回文章列表",
        "empty.list":"目前還沒有內容，敬請期待。","empty.404":"找不到這篇內容 — 可能已下架或網址有誤。",
        "pg.prev":"‹ 上一頁","pg.next":"下一頁 ›","an.prev":"上一篇","an.next":"下一篇",
        "t.now":"剛剛","t.min":"{n} 分鐘前","t.hour":"{n} 小時前","t.day":"{n} 天前",
        "theme.day":"白天模式（點擊切換）","theme.night":"夜間模式（點擊切換）","theme.auto":"自動日夜（點擊切換）"},
    en:{"sb.title":"Menu","sb.content":"Content","sb.tools":"Tools","sb.admin":"Admin","sb.manage":"Manage posts","sb.logs":"Visitor logs",
        "cat.news":"News","cat.article":"Articles","tab.ip":"IP Lookup","tab.ua":"UA Lookup",
        "foot.tool":"IP·UA Lookup","foot.rss":"RSS",
        "page.relay":"API relay","page.vpn":"VPN subscription","page.members":"Members","page.playground":"LLM playground",
        "back.news":"← Back to News","back.article":"← Back to Articles",
        "empty.list":"Nothing here yet — stay tuned.","empty.404":"Content not found — it may have been removed or the URL is wrong.",
        "pg.prev":"‹ Prev","pg.next":"Next ›","an.prev":"Previous","an.next":"Next",
        "t.now":"just now","t.min":"{n} min ago","t.hour":"{n} hr ago","t.day":"{n} days ago",
        "theme.day":"Day mode (tap to switch)","theme.night":"Night mode (tap to switch)","theme.auto":"Auto day/night (tap to switch)"}
  };
  var lang="zh";
  try{
    var saved=localStorage.getItem("ipua-lang");
    if(saved==="zh"||saved==="en") lang=saved;
    else{var l=(navigator.language||"").toLowerCase();lang=l.indexOf("zh")===0?"zh":"en";}
  }catch(e){}
  function t(key,vars){
    var s=(I18N[lang]&&I18N[lang][key])||I18N.zh[key]||key;
    if(vars)for(var k in vars)s=s.split("{"+k+"}").join(vars[k]);
    return s;
  }
  /* --- 相對時間：伺服器輸出絕對日期，這裡換算成「3 小時前」；太久以前維持日期 --- */
  function relText(iso){
    var ts=Date.parse(iso);if(isNaN(ts))return null;
    var s=(Date.now()-ts)/1000;if(s<0)return null;
    if(s<60)return t("t.now");
    if(s<3600)return t("t.min",{n:Math.floor(s/60)});
    if(s<86400)return t("t.hour",{n:Math.floor(s/3600)});
    if(s<86400*30)return t("t.day",{n:Math.floor(s/86400)});
    return null;
  }
  function renderTimes(){
    var ts=document.querySelectorAll("time[data-ts]");
    for(var i=0;i<ts.length;i++){
      var el=ts[i];
      if(!el.getAttribute("data-abs"))el.setAttribute("data-abs",el.textContent);
      var r=relText(el.getAttribute("data-ts"));
      el.textContent=r||el.getAttribute("data-abs");
    }
  }
  function applyI18n(){
    document.documentElement.lang=(lang==="zh"?"zh-Hant":"en");
    var els=document.querySelectorAll("[data-i18n]");
    for(var i=0;i<els.length;i++)els[i].textContent=t(els[i].getAttribute("data-i18n"));
    var ars=document.querySelectorAll("[data-i18n-aria]");
    for(var j=0;j<ars.length;j++)ars[j].setAttribute("aria-label",t(ars[j].getAttribute("data-i18n-aria")));
    /* 自訂選單項目：中文寫在內容裡、英文放 data-en；第一次先把中文備份到 data-zh 再切換 */
    var ens=document.querySelectorAll("[data-en]");
    for(var m=0;m<ens.length;m++){
      var en=ens[m];
      if(!en.getAttribute("data-zh"))en.setAttribute("data-zh",en.textContent);
      var ev=en.getAttribute("data-en");
      en.textContent=(lang==="en"&&ev)?ev:en.getAttribute("data-zh");
    }
    var lb=document.getElementById("langToggle");if(lb)lb.textContent=(lang==="zh"?"EN":"中");
    if(typeof __TKEY==="string"&&__TKEY)document.title=t(__TKEY)+" · "+__BRAND;
    renderTimes();
  }
  document.getElementById("langToggle").addEventListener("click",function(){
    lang=(lang==="zh")?"en":"zh";
    try{localStorage.setItem("ipua-lang",lang)}catch(e){}
    applyI18n();applyTheme();
    // 廣播給 JS 動態渲染的區塊（帳號鈕、/relay /vpn /members 面板）跟著切語言
    try{window.dispatchEvent(new CustomEvent("ipua:lang",{detail:{lang:lang}}));}catch(e){}
  });
  /* --- 主題三段式（與主站同邏輯、同儲存鍵）：day 白底（預設）/ night 黑底 / auto 依當地日夜。
         auto 用主站算好的日夜快取（ipua-auto），沒有就用裝置時鐘 6–18 點當白天。 --- */
  var THEME_MODES=["day","night","auto"],themeMode="day",autoCache=null;
  try{var m0=localStorage.getItem("ipua-theme-mode");if(THEME_MODES.indexOf(m0)>=0)themeMode=m0}catch(e){}
  try{autoCache=localStorage.getItem("ipua-auto")}catch(e){}
  function autoThemeGuess(){
    if(autoCache==="light"||autoCache==="dark")return autoCache;
    var h=new Date().getHours();return(h>=6&&h<18)?"light":"dark";
  }
  function applyTheme(){
    var th=themeMode==="night"?"dark":(themeMode==="auto"?autoThemeGuess():"light");
    document.documentElement.setAttribute("data-theme",th);
    var b=document.getElementById("themeToggle");
    /* \\ufe0e 強制黑白字形（不然 ☀ 會被畫成彩色 emoji）；自動模式用幾何符 ◐ 取代彩色 🌓 */
    b.textContent=themeMode==="day"?"\\u2600\\ufe0e":(themeMode==="night"?"\\u263e":"\\u25d0");
    b.title=t("theme."+themeMode);b.setAttribute("aria-label",t("theme."+themeMode));
  }
  document.getElementById("themeToggle").addEventListener("click",function(){
    themeMode=THEME_MODES[(THEME_MODES.indexOf(themeMode)+1)%THEME_MODES.length];
    try{localStorage.setItem("ipua-theme-mode",themeMode)}catch(e){}
    applyTheme();
  });
  /* --- 側邊欄 --- */
  var sb=document.getElementById("sidebar"),ov=document.getElementById("sbOverlay"),
      btn=document.getElementById("menuBtn"),cls=document.getElementById("sbClose");
  function setOpen(open){
    sb.classList.toggle("open",open);ov.classList.toggle("show",open);
    sb.setAttribute("aria-hidden",open?"false":"true");btn.setAttribute("aria-expanded",open?"true":"false");
    if(open)sb.removeAttribute("inert");else sb.setAttribute("inert","");
    document.body.style.overflow=open?"hidden":"";
    if(open){var f=sb.querySelector(".sb-link");if(f)f.focus()}else btn.focus();
  }
  btn.addEventListener("click",function(){setOpen(!sb.classList.contains("open"))});
  cls.addEventListener("click",function(){setOpen(false)});
  ov.addEventListener("click",function(){setOpen(false)});
  document.addEventListener("keydown",function(e){if(e.key==="Escape"&&sb.classList.contains("open"))setOpen(false)});
  /* --- 站長工具（✎ 編輯模式＋側邊欄站長區）：登入過後台的裝置（localStorage 有金鑰）
         或本機開發才載入 /assets/adminbar.js；一般訪客完全不會下載這支程式 --- */
  try{
    if(localStorage.getItem("ipua-logs-token")||location.hostname==="localhost"||location.hostname==="127.0.0.1"){
      var abs=document.createElement("script");abs.src="/assets/adminbar.js?v=20260714";document.head.appendChild(abs);
    }
  }catch(e){}
  applyI18n();
  applyTheme();
})();
`;
