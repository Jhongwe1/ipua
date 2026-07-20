// GET /logs — 訪客紀錄管理頁（管理員專用）。
// 2026-07-09 起改用全站共用外殼（src/lib/site.ts pageShell）：☰ 側邊欄、日夜、EN/中 與其他頁一致。
// 頁面行為在 public/assets/logs.js；資料要帶金鑰打 /api/logs 才拿得到，沒金鑰只會看到驗證畫面。
import { html, pageShell, ADMIN_CSS } from "../lib/site.js";
import { getChromeFor } from "../lib/chrome.js";
import type { RouteCtx } from "../types.js";

const PAGE_CSS = `
  .wrap{max-width:980px}
  table{min-width:700px}
  .tabs{display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap}
  .tabbtn{border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:20px;padding:8px 18px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;transition:.15s}
  .tabbtn:hover{border-color:var(--line2)}
  .tabbtn.on{background:var(--accent);color:var(--accent-fg);border-color:var(--line2)}
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
  <div class="card-title">管理員驗證</div>
  <p class="hint">這一頁只有管理員能看。用管理員 Google 帳號 <a href="/auth/login?next=/logs">登入</a>，或輸入管理金鑰（LOGS_TOKEN）；金鑰只會存在這台裝置的瀏覽器裡，不會外傳。</p>
  <form id="gateForm" class="query">
    <input id="tokenInput" type="password" autocomplete="off" placeholder="管理金鑰">
    <button type="submit">進入</button>
  </form>
  <div id="gateErr" class="error hidden">⚠ 金鑰不正確，請再試一次。</div>
</section>

<!-- 主畫面 -->
<section id="main" class="hidden">
  <div class="tabs">
    <button id="tabVisits" class="tabbtn on" type="button">訪客</button>
    <button id="tabErrors" class="tabbtn" type="button">錯誤</button>
    <button id="tabStats" class="tabbtn" type="button">用量</button>
  </div>

  <!-- 分頁 1：訪客紀錄 -->
  <div id="paneVisits">
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
  </div>

  <!-- 分頁 2：站內錯誤（errlog：relay / playground / OAuth / CSP 埋點） -->
  <div id="paneErrors" class="hidden">
    <div class="toolbar">
      <button id="errRefreshBtn" class="ghost" type="button">重新整理</button>
      <span class="sp"></span>
      <button id="errClearBtn" class="ghost danger" type="button">清空全部</button>
    </div>
    <div class="card tbl-card">
      <div class="tbl-wrap">
        <table>
          <thead><tr><th>時間</th><th>來源</th><th>訊息</th><th>路徑</th></tr></thead>
          <tbody id="errBody"></tbody>
        </table>
      </div>
      <div id="errEmpty" class="tbl-empty hidden">沒有錯誤 — 太平無事 🎉</div>
    </div>
    <div class="more-row"><button id="errMoreBtn" class="ghost hidden">載入更多</button></div>
    <p class="pagenote">relay 上游故障、playground 串流錯誤、OAuth 失敗、CSP 違規（10% 取樣）都會進這裡 · 點一列展開細節</p>
  </div>

  <!-- 分頁 3：用量統計（req_log：計量與延遲數據） -->
  <div id="paneStats" class="hidden">
    <div class="toolbar">
      <span style="font-size:13px;color:var(--muted)">範圍：</span>
      <button class="tabbtn dayBtn on" data-days="7" type="button">7 天</button>
      <button class="tabbtn dayBtn" data-days="14" type="button">14 天</button>
      <button class="tabbtn dayBtn" data-days="30" type="button">30 天</button>
    </div>
    <div class="chips">
      <div class="chip"><b id="uTotal">—</b><span>請求數</span></div>
      <div class="chip"><b id="uErrs">—</b><span>錯誤數</span></div>
      <div class="chip"><b id="uP50">—</b><span>耗時 p50 (ms)</span></div>
      <div class="chip"><b id="uP95">—</b><span>耗時 p95 (ms)</span></div>
      <div class="chip"><b id="uTokens">—</b><span>tokens 合計</span></div>
      <div class="chip"><b id="uCost">—</b><span>估算成本 (USD)</span></div>
    </div>
    <div id="unpricedNote" class="error hidden" style="margin-bottom:14px"></div>
    <div class="card tbl-card">
      <div class="card-title" style="padding:12px 14px 0">各渠道 × 模型</div>
      <div class="tbl-wrap">
        <table>
          <thead><tr><th>服務</th><th>渠道</th><th>模型</th><th>請求</th><th>錯誤</th><th>平均耗時</th><th>平均首字</th><th>tokens in/out</th><th>估算成本</th></tr></thead>
          <tbody id="chBody"></tbody>
        </table>
      </div>
      <div id="chEmpty" class="tbl-empty hidden">這段期間沒有請求。</div>
    </div>
    <div class="card tbl-card">
      <div class="card-title" style="padding:12px 14px 0">每人彙總</div>
      <div class="tbl-wrap">
        <table>
          <thead><tr><th>會員</th><th>請求</th><th>tokens in/out</th><th>估算成本</th></tr></thead>
          <tbody id="userBody"></tbody>
        </table>
      </div>
      <div id="userEmpty" class="tbl-empty hidden">這段期間沒有請求。</div>
    </div>
    <div class="card tbl-card">
      <div class="card-title" style="padding:12px 14px 0">每日</div>
      <div class="tbl-wrap">
        <table>
          <thead><tr><th>日期 (UTC)</th><th>服務</th><th>請求</th><th>錯誤</th><th>平均耗時</th><th>tokens in/out</th></tr></thead>
          <tbody id="dayBody"></tbody>
        </table>
      </div>
    </div>
    <p class="pagenote">數據源＝req_log（中轉與 Playground 每次請求一列；90 天自動輪替）· p50/p95 由最近 2000 筆原始值計算 · 成本為<b>估算值</b>（上游回報的 token 數 × 管理員在 /api/admin/prices 維護的定價）</p>
  </div>
</section>
<script data-nonce src="/assets/logs.js?v=20260717"><\/script>`;

export async function onRequestGet({ request, env }: RouteCtx): Promise<Response> {
  const { chrome } = await getChromeFor(env, request); // 選單依身分過濾（VPN 隱形）
  return html(
    pageShell({
      title: "訪客紀錄",
      desc: "管理員專用的訪客紀錄管理頁。",
      noindex: true,
      chrome: chrome,
      activePath: "/logs",
      h1: "訪客紀錄",
      headExtra: "<style>" + ADMIN_CSS + PAGE_CSS + "</style>\n",
      body: BODY
    })
  );
}
