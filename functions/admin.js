// GET /admin — 文章管理後台（站長專用；支援 ?edit=編號、?new=分類 直達）。
// 2026-07-09 起改用全站共用外殼（lib/site.js pageShell）：☰ 側邊欄、日夜、EN/中 與其他頁一致。
// 頁面行為在 public/assets/admin.js；內文預覽直接吃外殼的 .prose 樣式，跟正式文章頁完全同一份。
import { html, pageShell, ADMIN_CSS } from "../lib/site.js";
import { getChromeFor } from "../lib/chrome.js";

const PAGE_CSS = `
  .wrap{max-width:860px}
  table{min-width:560px}
  td{vertical-align:middle}
  tbody tr{cursor:pointer}
  tbody tr:hover td{background:var(--field)}
  .t-title{font-weight:600;max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .chip{display:inline-block;font-size:11px;font-weight:700;border-radius:20px;padding:2px 10px;border:1px solid var(--line);color:var(--muted);vertical-align:1px}
  .chip.pub{background:var(--accent);color:var(--accent-fg);border-color:var(--line2)}
  .field{margin-bottom:14px}
  .field label{display:block;font-size:12px;font-weight:700;color:var(--muted);letter-spacing:.06em;margin-bottom:6px}
  .grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  @media(max-width:560px){.grid2{grid-template-columns:1fr}}
  #fBody{min-height:320px;font-family:ui-monospace,"SFMono-Regular",Menlo,Consolas,monospace;font-size:13.5px}
  .coverbox{display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap}
  .coverbox .cin{flex:1;min-width:200px}
  #coverPrev{width:150px;aspect-ratio:5/3;object-fit:cover;border-radius:8px;border:1px solid var(--line);display:block}
  #msg{font-size:13px;color:var(--muted)}
  .pagenote{margin-top:18px;text-align:center;color:var(--sub);font-size:11px}
`;

const BODY = `
<!-- 金鑰驗證（與 /logs 同一把管理金鑰） -->
<section id="gate" class="card hidden">
  <div class="card-title">站長驗證</div>
  <p class="hint">這一頁只有站長能用。用站長 Google 帳號 <a href="/auth/login?next=/admin">登入</a>，或輸入管理金鑰（與訪客紀錄相同那一把）；金鑰只存在這台裝置的瀏覽器裡。</p>
  <form id="gateForm" class="query">
    <input id="tokenInput" type="password" autocomplete="off" placeholder="管理金鑰">
    <button type="submit">進入</button>
  </form>
  <div id="gateErr" class="error hidden">⚠ 金鑰不正確，請再試一次。</div>
</section>

<!-- 文章列表 -->
<section id="listView" class="hidden">
  <div class="toolbar">
    <button id="newBtn" class="primary" type="button">＋ 新增文章</button>
    <button id="reloadBtn" class="ghost" type="button">重新整理</button>
    <span class="sp"></span>
    <button id="logoutBtn" class="ghost" type="button">清除金鑰</button>
  </div>
  <div class="card tbl-card">
    <div class="tbl-wrap">
      <table>
        <thead><tr><th>標題</th><th>分類</th><th>狀態</th><th>瀏覽</th><th>發佈時間</th></tr></thead>
        <tbody id="tbody"></tbody>
      </table>
    </div>
    <div id="listEmpty" class="tbl-empty hidden">還沒有任何文章 — 按「＋ 新增文章」開始寫第一篇。</div>
  </div>
  <p class="pagenote">文章與圖片存於 D1 資料庫 · 發佈後立即出現在 /news 或 /articles · 圖片上傳前會自動壓縮</p>
</section>

<!-- 編輯器 -->
<section id="editView" class="hidden">
  <div class="toolbar">
    <button id="backBtn" class="ghost" type="button">← 回列表</button>
    <span id="editState" class="hint" style="margin:0"></span>
    <span class="sp"></span>
    <a id="viewLink" class="ghost hidden" target="_blank" rel="noopener">檢視 ↗</a>
  </div>

  <div class="card">
    <div class="grid2">
      <div class="field">
        <label for="fCat">分類</label>
        <select id="fCat">
          <option value="news">新聞</option>
          <option value="article">文章</option>
        </select>
      </div>
      <div class="field">
        <label for="fTitle">標題（必填）</label>
        <input id="fTitle" type="text" autocomplete="off" placeholder="文章標題">
      </div>
    </div>

    <div class="field">
      <label for="fSummary">摘要</label>
      <textarea id="fSummary" rows="2" placeholder="一兩句話簡介 — 顯示在列表標題下方，也是 Google 搜尋結果與分享卡片的描述文字"></textarea>
    </div>

    <div class="field">
      <label>縮圖（列表與分享預覽用，建議橫式）</label>
      <div class="coverbox">
        <img id="coverPrev" class="hidden" alt="縮圖預覽">
        <div class="cin">
          <input id="fCover" type="text" autocomplete="off" placeholder="上傳後自動填入，也可以直接貼圖片網址">
          <div class="toolbar" style="margin:10px 0 0">
            <button id="coverBtn" class="ghost" type="button">上傳縮圖</button>
            <button id="coverClear" class="ghost" type="button">清除</button>
          </div>
        </div>
      </div>
    </div>

    <div class="field">
      <label for="fBody">內文（Markdown：空一行分段、<span class="mono">## 標題</span>、<span class="mono">**粗體**</span>、<span class="mono">[文字](網址)</span>）</label>
      <div class="toolbar" style="margin-bottom:10px">
        <button id="imgBtn" class="ghost" type="button">插入圖片</button>
        <span id="upMsg" class="hint" style="margin:0"></span>
      </div>
      <textarea id="fBody" spellcheck="false" placeholder="在這裡寫內文…"></textarea>
    </div>
  </div>

  <div class="card">
    <div class="card-title">預覽（與正式頁面同樣式）</div>
    <div id="pv" class="prose"><p class="hint">開始輸入內文後這裡會即時預覽。</p></div>
  </div>

  <div class="toolbar">
    <button id="saveBtn" class="primary" type="button">儲存草稿</button>
    <button id="pubBtn" class="ghost" type="button">發佈</button>
    <span id="msg"></span>
    <span class="sp"></span>
    <button id="delBtn" class="ghost danger hidden" type="button">刪除</button>
  </div>
</section>
<script src="/assets/marked.js"><\/script>
<script src="/assets/admin.js"><\/script>`;

export async function onRequestGet({ request, env }) {
  const { chrome } = await getChromeFor(env, request);   // 選單依身分過濾（VPN 隱形）
  return html(pageShell({
    title: "文章管理",
    desc: "站長專用的文章管理後台。",
    noindex: true,
    chrome: chrome,
    activePath: "/admin",
    h1: "文章管理",
    headExtra: "<style>" + ADMIN_CSS + PAGE_CSS + "</style>\n",
    body: BODY
  }));
}
