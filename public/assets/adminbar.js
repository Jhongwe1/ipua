/* adminbar.js — 管理員編輯工具（2026-07-17 UI 改版：管理員區統整）。
   載入時機：登入過後台的裝置（localStorage 有金鑰）、Google 管理員（account.js 偵測到 is_admin 後載入）、
   或本機開發。一般訪客不會下載這支；真正的權限仍在伺服器端每支 /api/admin/* 驗證。

   2026-07-17 起的配置（管理員要求）：
     - 側邊欄「選單」標題右邊一顆小 ✎ ＝ 進入選單編輯模式（以前是列表裡的「編輯選單」項）
     - 「管理員」區收斂成四頁：管理員設定（/settings）、成員管理（/members）、
       訪客紀錄（/logs）、API 文件（/api-docs）；文章頁另有情境式「編輯這篇文章」
     - /news、/articles 列表頁的頁首多一顆「＋」＝新增文章（以前是列表裡的「新增文章」項）
     - 網站名稱改到 /settings 頁；window.__ipuaMenuEdit 供 /settings 的「✎ 編輯選單」鈕呼叫
   編輯選單＝把側邊欄變成編輯器（↑↓ 排序、改名、刪除、＋連結/分類、還原預設），即時自動儲存。 */
(function () {
  "use strict";
  if (window.__ipuaAdminbar) return;
  window.__ipuaAdminbar = 1;

  var token = "";
  try { token = localStorage.getItem("ipua-logs-token") || ""; } catch (e) {}

  var lang = "zh";
  try { if (localStorage.getItem("ipua-lang") === "en") lang = "en"; } catch (e) {}
  function tx(zh, en) { return lang === "en" ? en : zh; }

  /* ===== 小工具 ===== */
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }
  function api(path, opts) {
    opts = opts || {};
    opts.headers = opts.headers || {};
    if (token) opts.headers["Authorization"] = "Bearer " + token;   // 沒 token 就靠登入 cookie（同源自動帶）
    if (opts.json !== undefined) {
      opts.method = opts.method || "POST";
      opts.headers["content-type"] = "application/json";
      opts.body = JSON.stringify(opts.json);
      delete opts.json;
    }
    return fetch(path, opts).then(function (r) {
      if (r.status === 401) throw { auth: true };
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok) throw new Error(d.hint || d.error || ("HTTP " + r.status));
        return d;
      });
    });
  }
  function alertErr(e) {
    if (e && e.auth) alert(tx("登入已失效 — 請用管理員 Google 帳號重新登入，或到 /admin 輸入管理金鑰。", "Session expired — sign in again."));
    else alert(tx("操作失敗：", "Failed: ") + (e && e.message || e));
  }

  /* ===== 樣式 ===== */
  var css =
    "button.sb-link{width:100%;text-align:left;border:0;background:none;font-family:inherit;cursor:pointer}" +
    ".sb-action{font-size:13.5px}" +
    /* 「選單」標題右邊的小 ✎（管理員才看得到）：✕ 靠 margin-left:auto 推回最右 */
    "#sbClose{margin-left:auto}" +
    "#sbMenuEdit{width:26px;height:26px;min-width:26px;margin-left:8px;padding:0;border:1px solid var(--line);background:var(--card);color:var(--muted);border-radius:13px;font-size:12px;line-height:1;cursor:pointer;font-family:inherit;display:inline-flex;align-items:center;justify-content:center;transition:.15s}" +
    "#sbMenuEdit:hover{border-color:var(--line2);color:var(--fg)}" +
    /* 列表頁頁首的「＋ 新增文章」（管理員才看得到）：樣式同 .ctrl 圓鈕 */
    "#abNewPost{width:38px;padding:0;font-size:19px;font-weight:400;text-decoration:none}" +
    /* 彈窗：overlay 可捲動＋margin:auto ＝ 內容矮時置中、高時（手機鍵盤彈出）可捲，不會卡在鍵盤後面 */
    ".ab-ov{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:80;display:flex;align-items:flex-start;justify-content:center;padding:16px;overflow:auto;overscroll-behavior:contain}" +
    ".ab-dlg{background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:14px;padding:18px;width:100%;max-width:360px;margin:auto;box-shadow:0 12px 44px rgba(0,0,0,.3)}" +
    ".ab-dlg h3{font-size:16px;font-weight:700;margin:0 0 4px}" +
    ".ab-dlg label{display:block;font-size:12px;font-weight:700;color:var(--muted);margin:12px 0 5px}" +
    ".ab-dlg input{width:100%;border:1px solid var(--line);background:var(--field);color:var(--fg);border-radius:8px;padding:10px 11px;font-size:14px;font-family:inherit;outline:none;box-sizing:border-box}" +
    ".ab-dlg input:focus{border-color:var(--line2)}" +
    ".ab-btns{display:flex;gap:8px;justify-content:flex-end;margin-top:16px}" +
    ".ab-btn{border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:8px;padding:9px 16px;font-size:13.5px;font-weight:600;cursor:pointer;font-family:inherit}" +
    ".ab-btn:hover{border-color:var(--line2)}" +
    ".ab-btn.pri{background:var(--accent);color:var(--accent-fg);border-color:var(--line2)}" +
    ".ab-ed{padding:4px 2px 18px}" +
    ".ab-ed-head{font-size:12px;color:var(--muted);padding:12px 8px 4px;line-height:1.6}" +
    ".ab-status{font-size:12px;color:var(--muted);padding:0 8px 6px;min-height:17px}" +
    ".ab-row{display:flex;align-items:center;gap:5px;padding:6px 6px;border-radius:8px;margin:1px 0}" +
    ".ab-row:hover{background:var(--field)}" +
    ".ab-row.ab-sec{margin-top:7px}" +
    ".ab-row.ab-sec .ab-lab{text-transform:uppercase;letter-spacing:.07em;font-size:11.5px;color:var(--muted)}" +
    ".ab-main{flex:1;min-width:0}" +
    ".ab-lab{font-size:13.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
    ".ab-url{font-size:11px;color:var(--sub);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
    ".ab-mini{width:27px;height:27px;min-width:27px;border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:7px;font-size:12px;cursor:pointer;padding:0;font-family:inherit;display:inline-flex;align-items:center;justify-content:center}" +
    ".ab-mini:hover{border-color:var(--line2)}" +
    ".ab-mini[disabled]{opacity:.3;cursor:default}" +
    ".ab-ed-foot{display:flex;flex-wrap:wrap;gap:6px;padding:12px 6px 0}";
  var styleEl = el("style");
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  /* ===== 頁面情境 ===== */
  var artM = location.pathname.match(/^\/(news|articles)\/(\d+)$/);   // 文章頁 → 可「編輯這篇」
  var newCat = /^\/articles/.test(location.pathname) ? "article" : "news";

  /* ===== 側邊欄「管理員」區（純文字，不加前綴小圖示 — 管理員 2026-07-14 要求） ===== */
  function itemLink(zh, en, href) {
    var a = el("a", "sb-link sb-action", tx(zh, en));
    a.href = href;
    a.setAttribute("data-en", en); a.setAttribute("data-zh", zh);
    if (location.pathname === href) a.className += " active";
    return a;
  }
  function itemBtn(zh, en, fn) {
    var b = el("button", "sb-link sb-action", tx(zh, en));
    b.type = "button";
    b.setAttribute("data-en", en); b.setAttribute("data-zh", zh);
    b.addEventListener("click", fn);
    return b;
  }
  function adminNav() {
    var host = document.getElementById("sbAdmin") ||
      (document.getElementById("sidebar") && document.getElementById("sidebar").querySelector("nav"));
    if (!host || host.getAttribute("data-ab")) return;
    host.setAttribute("data-ab", "1");

    var sec = el("div", "sb-sec", tx("管理員", "Admin"));
    sec.setAttribute("data-en", "Admin"); sec.setAttribute("data-zh", "管理員");
    host.appendChild(sec);

    // 2026-07-17 統整（稍晚管理員要求把成員管理加回來）：固定四頁
    //（其餘入口在 /settings 的「其他管理頁」與頭像選單）
    if (artM) host.appendChild(itemLink("編輯這篇文章", "Edit this post", "/admin?edit=" + artM[2]));
    host.appendChild(itemLink("管理員設定", "Admin settings", "/settings"));
    host.appendChild(itemLink("成員管理", "Members", "/members"));
    host.appendChild(itemLink("訪客紀錄", "Visitor logs", "/logs"));
    host.appendChild(itemLink("API 文件", "API docs", "/api-docs"));
  }

  /* ===== 「選單」標題右邊的小 ✎（進入選單編輯模式） ===== */
  function mountMenuEditBtn() {
    var head = document.querySelector("#sidebar .sb-head");
    if (!head || document.getElementById("sbMenuEdit")) return;
    var b = el("button", null, "✎");    // ✎
    b.id = "sbMenuEdit"; b.type = "button";
    b.title = tx("編輯選單", "Edit menu");
    b.setAttribute("aria-label", tx("編輯選單", "Edit menu"));
    b.addEventListener("click", startMenuEdit);
    var title = head.querySelector("span");
    if (title && title.nextSibling) head.insertBefore(b, title.nextSibling);
    else head.appendChild(b);
  }

  /* ===== /news、/articles 列表頁頁首的「＋ 新增文章」 ===== */
  function mountNewPostBtn() {
    if (!/^\/(news|articles)\/?$/.test(location.pathname)) return;
    var c = document.querySelector("header .ctrls");
    if (!c || document.getElementById("abNewPost")) return;
    var a = el("a", "ctrl", "＋");
    a.id = "abNewPost";
    a.href = "/admin?new=" + newCat;
    a.title = tx("新增文章", "New post");
    a.setAttribute("aria-label", tx("新增文章", "New post"));
    c.insertBefore(a, c.firstChild);
  }

  /* ===== 通用小對話框 ===== */
  function dialog(title, hint, fields, onOk) {
    var ov = el("div", "ab-ov"), dlg = el("div", "ab-dlg");
    dlg.appendChild(el("h3", null, title));
    if (hint) { var h = el("div", null, hint); h.style.cssText = "font-size:12px;color:var(--muted);line-height:1.6"; dlg.appendChild(h); }
    var form = el("form"), inputs = {};
    fields.forEach(function (f) {
      var lb = el("label", null, f.label);
      var inp = el("input");
      inp.type = "text"; inp.value = f.val || ""; inp.placeholder = f.ph || "";
      inp.autocomplete = "off"; inp.spellcheck = false;
      inputs[f.k] = inp;
      form.appendChild(lb); form.appendChild(inp);
    });
    var btns = el("div", "ab-btns");
    var cancel = el("button", "ab-btn", tx("取消", "Cancel")); cancel.type = "button";
    var ok = el("button", "ab-btn pri", tx("確定", "OK")); ok.type = "submit";
    btns.appendChild(cancel); btns.appendChild(ok);
    form.appendChild(btns);
    dlg.appendChild(form);
    ov.appendChild(dlg);
    function close() { document.removeEventListener("keydown", onKey); ov.remove(); }
    function onKey(e) { if (e.key === "Escape") close(); }
    cancel.addEventListener("click", close);
    ov.addEventListener("click", function (e) { if (e.target === ov) close(); });
    document.addEventListener("keydown", onKey);
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var vals = {};
      for (var k in inputs) vals[k] = inputs[k].value.trim();
      close();
      onOk(vals);
    });
    document.body.appendChild(ov);
    var first = form.querySelector("input");
    if (first) first.focus();
  }

  /* ===== 選單編輯器 ===== */
  var items = null, saveTimer = null, statusEl = null, rowsBox = null;

  function status(t) { if (statusEl) statusEl.textContent = t || ""; }
  function scheduleSave() {
    status(tx("儲存中…", "Saving…"));
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      api("/api/admin/menu", { method: "PUT", json: { items: items } })
        .then(function () { status(tx("✓ 已儲存", "✓ Saved")); })
        .catch(function (e) { status(tx("⚠ 儲存失敗", "⚠ Save failed")); alertErr(e); });
    }, 600);
  }
  function openSidebar() {
    var sb = document.getElementById("sidebar");
    if (sb && !sb.classList.contains("open")) {
      var mb = document.getElementById("menuBtn");
      if (mb) mb.click();
    }
  }
  function startMenuEdit() {
    api("/api/menu").then(function (d) {
      items = (d.items || []).map(function (it) {
        return {
          kind: it.kind === "section" ? "section" : "link",
          label: it.label || "",
          label_en: it.label_en || "",
          url: it.url || ""
        };
      });
      openSidebar();
      buildEditor();
      renderRows();
      if (!d.custom) status(tx("目前是預設選單，改了才會存成自訂", "Default menu — edits will be saved as custom"));
    }).catch(alertErr);
  }
  function buildEditor() {
    if (document.querySelector(".ab-ed")) return;
    var sb = document.getElementById("sidebar");
    var nav = sb && sb.querySelector("nav");
    if (!nav) return;
    var m = document.getElementById("sbMenu"); if (m) m.style.display = "none";
    var a = document.getElementById("sbAdmin"); if (a) a.style.display = "none";
    var ed = el("div", "ab-ed");
    ed.appendChild(el("div", "ab-ed-head", tx("編輯選單 — ↑↓ 排順序、「改」改名／改網址；改動會自動儲存，按「完成」重新整理套用。",
      "Edit menu — reorder with ↑↓, tap 改 to rename/relink; changes auto-save, tap Done to apply.")));
    statusEl = el("div", "ab-status");
    ed.appendChild(statusEl);
    rowsBox = el("div");
    ed.appendChild(rowsBox);
    var foot = el("div", "ab-ed-foot");
    function fbtn(text, pri, fn) {
      var b = el("button", "ab-btn" + (pri ? " pri" : ""), text);
      b.type = "button";
      b.addEventListener("click", fn);
      foot.appendChild(b);
      return b;
    }
    fbtn(tx("＋ 連結", "＋ Link"), false, addLink);
    fbtn(tx("＋ 分類", "＋ Section"), false, addSection);
    fbtn(tx("還原預設", "Reset"), false, restoreDefault);
    fbtn(tx("✓ 完成", "✓ Done"), true, finishEdit);
    ed.appendChild(foot);
    nav.appendChild(ed);
  }
  function renderRows() {
    if (!rowsBox) return;
    rowsBox.innerHTML = "";
    items.forEach(function (it, i) {
      var row = el("div", "ab-row" + (it.kind === "section" ? " ab-sec" : ""));
      function mini(text, disabled, fn) {
        var b = el("button", "ab-mini", text);
        b.type = "button";
        if (disabled) b.disabled = true;
        else b.addEventListener("click", fn);
        row.appendChild(b);
        return b;
      }
      mini("↑", i === 0, function () { move(i, -1); });
      mini("↓", i === items.length - 1, function () { move(i, 1); });
      var main = el("div", "ab-main");
      main.appendChild(el("div", "ab-lab", it.label + (it.label_en ? "｜" + it.label_en : "")));
      main.appendChild(el("div", "ab-url", it.kind === "section" ? tx("分類標題", "Section") : it.url));
      row.appendChild(main);
      mini(tx("改", "✎"), false, function () { editItem(i); });
      mini("✕", false, function () { removeItem(i); });
      rowsBox.appendChild(row);
    });
    if (!items.length) rowsBox.appendChild(el("div", "ab-ed-head", tx("（選單是空的 — 加點東西，或「還原預設」）", "(empty — add items or Reset)")));
  }
  function move(i, d) {
    var j = i + d;
    if (j < 0 || j >= items.length) return;
    var t = items[i]; items[i] = items[j]; items[j] = t;
    renderRows();
    scheduleSave();
  }
  function removeItem(i) {
    if (!confirm(tx("刪除「", "Delete “") + items[i].label + "”？")) return;
    items.splice(i, 1);
    renderRows();
    scheduleSave();
  }
  function validUrl(u) { return /^(\/|https?:\/\/)/.test(u); }
  function editItem(i) {
    var it = items[i];
    var fields = [
      { k: "label", label: tx("名稱（中文）", "Name"), val: it.label },
      { k: "label_en", label: tx("英文名稱（可留空）", "English name (optional)"), val: it.label_en }
    ];
    if (it.kind === "link") fields.push({ k: "url", label: tx("連結網址", "URL"), val: it.url, ph: "/news 或 https://…" });
    dialog(it.kind === "section" ? tx("編輯分類", "Edit section") : tx("編輯連結", "Edit link"), "", fields, function (v) {
      if (!v.label) { alert(tx("名稱不能是空的", "Name required")); return; }
      if (it.kind === "link" && !validUrl(v.url)) { alert(tx("網址要以 / 或 http(s):// 開頭", "URL must start with / or http(s)://")); return; }
      it.label = v.label; it.label_en = v.label_en;
      if (it.kind === "link") it.url = v.url;
      renderRows();
      scheduleSave();
    });
  }
  function addLink() {
    dialog(tx("新增連結", "New link"), tx("會加在選單最下面，再用 ↑ 移到想要的位置。", "Added at the bottom; move up with ↑."), [
      { k: "label", label: tx("名稱（中文）", "Name"), ph: tx("例：關於本站", "e.g. About") },
      { k: "label_en", label: tx("英文名稱（可留空）", "English name (optional)"), ph: "About" },
      { k: "url", label: tx("連結網址", "URL"), ph: "/news 或 https://…" }
    ], function (v) {
      if (!v.label) { alert(tx("名稱不能是空的", "Name required")); return; }
      if (!validUrl(v.url)) { alert(tx("網址要以 / 或 http(s):// 開頭", "URL must start with / or http(s)://")); return; }
      items.push({ kind: "link", label: v.label, label_en: v.label_en, url: v.url });
      renderRows();
      scheduleSave();
    });
  }
  function addSection() {
    dialog(tx("新增分類", "New section"), tx("分類是選單裡的小標題，用來把連結分組。", "A section is a heading to group links."), [
      { k: "label", label: tx("名稱（中文）", "Name"), ph: tx("例：站外連結", "e.g. Links") },
      { k: "label_en", label: tx("英文名稱（可留空）", "English name (optional)"), ph: "Links" }
    ], function (v) {
      if (!v.label) { alert(tx("名稱不能是空的", "Name required")); return; }
      items.push({ kind: "section", label: v.label, label_en: v.label_en, url: "" });
      renderRows();
      scheduleSave();
    });
  }
  function restoreDefault() {
    if (!confirm(tx("還原成預設選單？自訂的項目會全部刪除。", "Reset to default menu? Custom items will be removed."))) return;
    clearTimeout(saveTimer);
    api("/api/admin/menu", { method: "PUT", json: { items: [] } })
      .then(function () { location.reload(); })
      .catch(alertErr);
  }
  function finishEdit() {
    clearTimeout(saveTimer);
    api("/api/admin/menu", { method: "PUT", json: { items: items } })
      .then(function () { location.reload(); })
      .catch(alertErr);
  }

  /* ===== 啟動 ===== */
  adminNav();
  mountMenuEditBtn();
  mountNewPostBtn();
  // /settings 頁的「✎ 編輯選單」鈕靠這個進編輯模式（網站名稱等其他設定都在 /settings）
  window.__ipuaMenuEdit = startMenuEdit;
})();
