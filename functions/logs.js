// GET /logs — 訪客紀錄管理頁（站長專用）。
// 2026-07-09 起改用全站共用外殼（lib/site.js pageShell）：☰ 側邊欄、日夜、EN/中 與其他頁一致。
// 頁面行為在 public/assets/logs.js；資料要帶金鑰打 /api/logs 才拿得到，沒金鑰只會看到驗證畫面。
import { html, pageShell, getChrome, ADMIN_CSS } from "../lib/site.js";

const PAGE_CSS = `
  .wrap{max-width:980px}
  table{min-width:700px}
  .chips{display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap}
  .chip{flex:1;min-width:130px;border:1px solid var(--line);border-radius:11px;padding:12px 14px;background:var(--card)}
  .chip b{display:block;font-size:22px;font-weight:700}
  .chip span{font-size:11px;color:var(--muted);letter-spacing:.05em}
  td{padding:9px 12px;vertical-align:top}
  tr.main{cursor:pointer}
  tr.main:hover td{background:var(--field)}
  .ua-line{max-width:280px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--muted);font-size:12px}
  .ua-name{font-weight:600}
  tr.detail td{background:var(--field);border-bottom:1px solid var(--line);padding:12px 14px}
  .kv{display:grid;grid-template-columns:96px 1fr;gap:4px 12px;font-size:12.5px}
  .kv .k{color:var(--muted)}
  .kv .v{overflow-wrap:anywhere}
  .more-row{display:flex;justify-content:center;gap:10px;margin-top:16px}
  .pagenote{margin-top:18px;text-align:center;color:var(--sub);font-size:11px}
  @media(max-width:480px){.chip b{font-size:18px}}
`;

const BODY = `
<!-- 金鑰輸入（驗證失敗或第一次來會顯示） -->
<section id="gate" class="card hidden">
  <div class="card-title">站長驗證</div>
  <p class="hint">這一頁只有站長能看。請輸入管理金鑰（LOGS_TOKEN）；金鑰只會存在這台裝置的瀏覽器裡，不會外傳。</p>
  <form id="gateForm" class="query">
    <input id="tokenInput" type="password" autocomplete="off" placeholder="管理金鑰">
    <button type="submit">進入</button>
  </form>
  <div id="gateErr" class="error hidden">⚠ 金鑰不正確，請再試一次。</div>
</section>

<!-- 主畫面 -->
<section id="main" class="hidden">
  <div class="chips">
    <div class="chip"><b id="stToday">—</b><span>今日瀏覽</span></div>
    <div class="chip"><b id="stTodayIps">—</b><span>今日不重複 IP</span></div>
    <div class="chip"><b id="stTotal">—</b><span>累計瀏覽</span></div>
  </div>

  <form id="searchForm" class="query">
    <input id="qInput" type="text" autocomplete="off" placeholder="搜尋 IP / UA / 路徑 / 國家 / ISP…">
    <button type="submit">搜尋</button>
    <button type="button" id="refreshBtn" class="ghost">重新整理</button>
  </form>

  <div class="card tbl-card">
    <div class="tbl-wrap">
      <table>
        <thead><tr><th>時間</th><th>IP</th><th>地點</th><th>路徑</th><th>裝置 / 瀏覽器</th></tr></thead>
        <tbody id="tbody"></tbody>
      </table>
    </div>
    <div id="empty" class="tbl-empty hidden">目前沒有紀錄。</div>
  </div>

  <div class="more-row">
    <button id="moreBtn" class="ghost hidden">載入更多</button>
    <button id="logoutBtn" class="ghost">清除金鑰</button>
  </div>

  <p class="pagenote">每次頁面瀏覽由 Cloudflare Pages Function 寫入 D1 資料庫 · 點一列可展開完整細節</p>
</section>
<script src="/assets/logs.js"><\/script>`;

export async function onRequestGet({ env }) {
  const chrome = await getChrome(env);
  return html(pageShell({
    title: "訪客紀錄",
    desc: "站長專用的訪客紀錄管理頁。",
    noindex: true,
    chrome: chrome,
    activePath: "/logs",
    h1: "訪客紀錄",
    headExtra: "<style>" + ADMIN_CSS + PAGE_CSS + "</style>\n",
    body: BODY
  }));
}
