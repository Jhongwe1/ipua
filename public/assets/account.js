/* account.js — 帳號區（v2.2 ChatGPT 風格改版：從右上角搬到側欄左下角）。全站每頁載入。
   未登入：側欄左下一顆「Sign in」大鈕＋頁首右上一顆「Sign in」小鈕 → 導向 Google 登入。
   已登入：側欄左下 頭像＋名字＋「聯絡我」小鈕（原 ChatGPT Upgrade 的位置）；
   點頭像上彈選單 — 一般會員：Log out／Log out everywhere；
   管理員多五項：管理員設定、成員管理、訪客紀錄、API 文件、文章管理（2026-07-22 拍板）。

   為了「一般匿名訪客不要無謂打 API」：登入時伺服器種了一個非 HttpOnly 的提示 cookie
   ipua_auth=1；沒有這個 cookie 就直接畫「Sign in」鈕，完全不呼叫 /api/me。
   拿到 /api/me 後廣播 ipua:me 事件（外殼靠它決定要不要載入 History 對話列表）。 */
(function () {
  "use strict";
  if (window.__ipuaAccount) return;
  window.__ipuaAccount = 1;

  function cookie(name) {
    var m = (document.cookie || "").match(new RegExp("(?:^|;\\s*)" + name + "=([^;]*)"));
    return m ? decodeURIComponent(m[1]) : "";
  }
  var loggedInHint = cookie("ipua_auth") === "1";
  var isLocal = /^(localhost|127\.)/.test(location.hostname);

  // 每次讀最新語言（v2.2 起預設英文，右上角切換 EN/中 後跟著變）
  function curLang() { try { return localStorage.getItem("ipua-lang") === "zh" ? "zh" : "en"; } catch (e) { return "en"; } }
  function tx(zh, en) { return curLang() === "zh" ? zh : en; }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /* ===== 樣式 ===== */
  var css =
    ".acct-row{display:flex;align-items:center;gap:10px;padding:8px;border-radius:10px;min-width:0}" +
    ".acct-row .hit{display:flex;align-items:center;gap:10px;flex:1;min-width:0;border:0;background:none;color:var(--fg);font-family:inherit;cursor:pointer;padding:0;text-align:left;border-radius:10px}" +
    ".acct-row img{width:30px;height:30px;border-radius:50%;object-fit:cover;background:var(--field);flex:0 0 auto}" +
    ".acct-row .nm{flex:1;min-width:0;font-size:13.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
    ".acct-row:hover{background:var(--hov)}" +
    ".acct-contact{flex:0 0 auto;border:1px solid var(--line);background:transparent;color:var(--fg);border-radius:16px;padding:5px 13px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;text-decoration:none;display:none;white-space:nowrap;transition:.15s}" +
    ".acct-contact:hover{border-color:var(--line2)}" +
    "#acctSignin{display:flex;width:100%;align-items:center;justify-content:center;gap:8px;background:var(--accent);color:var(--accent-fg);border:0;border-radius:10px;padding:11px 12px;font-size:13.5px;font-weight:700;text-decoration:none;cursor:pointer;font-family:inherit}" +
    "#acctTopSignin{background:var(--accent);color:var(--accent-fg);border-radius:17px;padding:0 14px;font-weight:700}" +
    "#acctTopSignin:hover{background:var(--accent);color:var(--accent-fg);opacity:.88}";
  var st = el("style"); st.textContent = css; document.head.appendChild(st);

  function acctHost() { return document.getElementById("sbAcct"); }
  function ctrls() { return document.querySelector("header .ctrls"); }

  /* ===== 未登入 ===== */
  function loginUrl() {
    return "/auth/login?next=" + encodeURIComponent(location.pathname + location.search);
  }
  function mountLogin() {
    var host = acctHost();
    if (host && !document.getElementById("acctSignin")) {
      var a = el("a", null, tx("登入", "Sign in"));
      a.id = "acctSignin";
      a.href = loginUrl();
      host.appendChild(a);
    }
    var c = ctrls();
    if (c && !document.getElementById("acctTopSignin")) {
      var b = el("a", "ctrl", tx("登入", "Sign in"));
      b.id = "acctTopSignin";
      b.href = loginUrl();
      c.insertBefore(b, c.firstChild);
    }
  }

  /* ===== 已登入：側欄左下 頭像＋名字＋聯絡我 ===== */
  var me = null, rowBtn = null, contactA = null, nmEl = null;

  function avatarFallback(email) {
    var ch = (email || "?").charAt(0).toUpperCase();
    return "data:image/svg+xml," + encodeURIComponent(
      "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 40'><rect width='40' height='40' fill='#888'/><text x='20' y='27' font-size='20' fill='#fff' text-anchor='middle' font-family='sans-serif'>" + ch + "</text></svg>");
  }

  // 管理員的聯絡方式：連結存 settings 表 contact_url 鍵，由公開的 /api/settings 讀回。
  // 沒設定＝不顯示 — 按鈕先隱藏，拿到網址才現身（原 ChatGPT「Upgrade」的位置）。
  function mountContact(a) {
    fetch("/api/settings", { cache: "no-store" }).then(function (r) { return r.json(); }).then(function (s) {
      if (s && s.contact_url) { a.href = s.contact_url; a.style.display = "inline-flex"; }
    }).catch(function () {});
  }

  function mountAvatar(user) {
    me = user;
    var host = acctHost();
    if (!host || document.getElementById("acctRow")) return;
    var row = el("div", "acct-row"); row.id = "acctRow";
    rowBtn = el("button", "hit"); rowBtn.type = "button";
    rowBtn.title = tx("帳號", "Account");
    var img = el("img"); img.alt = ""; img.referrerPolicy = "no-referrer";
    img.src = user.picture || avatarFallback(user.email);
    img.onerror = function () { img.src = avatarFallback(user.email); };
    rowBtn.appendChild(img);
    nmEl = el("span", "nm", user.name || user.email);
    rowBtn.appendChild(nmEl);
    rowBtn.addEventListener("click", function (e) { e.stopPropagation(); openMenu(); });
    row.appendChild(rowBtn);
    contactA = el("a", "acct-contact", tx("聯絡我", "Contact me"));
    contactA.target = "_blank"; contactA.rel = "noopener noreferrer";
    mountContact(contactA);
    row.appendChild(contactA);
    host.appendChild(row);
  }

  /* ===== 頭像上彈選單 ===== */
  function openMenu() {
    if (!window.SBPOP || !me) return;
    window.SBPOP.open(rowBtn, function (p) {
      p.appendChild(el("div", "phead", me.email));
      if (me.is_admin) {
        function link(zh, en, href) {
          var a = el("a", "pi", tx(zh, en));
          a.href = href;
          p.appendChild(a);
        }
        link("管理員設定", "Admin settings", "/settings");
        link("成員管理", "Members", "/members");
        link("訪客紀錄", "Visitor logs", "/logs");
        link("API 文件", "API docs", "/api-docs");
        link("文章管理", "Manage posts", "/admin");
        p.appendChild(el("div", "phr"));
      }
      window.SBPOP.item(p, tx("登出", "Log out"), logout);
      window.SBPOP.item(p, tx("登出所有裝置", "Log out everywhere"), function () {
        if (!confirm(tx("登出你在所有裝置上的登入狀態（包含這台）？", "Log out on every device, including this one?"))) return;
        fetch("/api/account/logout-all", { method: "POST" })
          .then(function () { location.reload(); })
          .catch(function () { location.reload(); });
      });
    }, true);
  }

  // 切換 EN/中 時：改字（選單是每次開啟重建，下次開就是新語言）
  function onLangChange() {
    var a = document.getElementById("acctSignin");
    if (a) a.textContent = tx("登入", "Sign in");
    var b = document.getElementById("acctTopSignin");
    if (b) b.textContent = tx("登入", "Sign in");
    if (contactA) contactA.textContent = tx("聯絡我", "Contact me");
    if (rowBtn) rowBtn.title = tx("帳號", "Account");
  }
  window.addEventListener("ipua:lang", onLangChange);

  function logout() {
    var f = document.createElement("form");
    f.method = "POST"; f.action = "/auth/logout";
    document.body.appendChild(f); f.submit();
  }

  /* ===== 啟動 ===== */
  function boot() {
    if (!loggedInHint && !isLocal) { mountLogin(); return; }   // 匿名訪客：只畫登入鈕，不打 API
    fetch("/api/me", { cache: "no-store" }).then(function (r) { return r.json(); }).then(function (d) {
      if (d && d.user) {
        window.__ipuaMe = d.user;
        mountAvatar(d.user);
        // 外殼靠這個事件決定要不要載入 History（有 playground 服務才載）
        try { window.dispatchEvent(new CustomEvent("ipua:me", { detail: { user: d.user } })); } catch (e) {}
        // 管理員 → 載入側欄編輯工具（若還沒被外殼的 localStorage 判斷載入）
        if (d.user.is_admin && !window.__ipuaAdminbar) {
          var s = document.createElement("script"); s.src = "/assets/adminbar.js?v=20260722b"; document.head.appendChild(s);
        }
      } else {
        mountLogin();   // 提示 cookie 過期／session 失效
      }
    }).catch(function () { mountLogin(); });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
