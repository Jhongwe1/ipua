/* account.js — 右上角「帳號」按鈕（2026-07-11 Google 登入上線）。全站每頁載入。
   未登入：顯示「登入」小鈕 → 導向 Google 登入。
   已登入：顯示大頭貼 → 下拉選單（信箱、API 中轉站、VPN 訂閱、站長：成員管理、登出）。

   為了「一般匿名訪客不要無謂打 API」：登入時伺服器種了一個非 HttpOnly 的提示 cookie
   ipua_auth=1；沒有這個 cookie 就直接畫「登入」鈕，完全不呼叫 /api/me。
   站長身分另有提示 cookie ipua_adm=1 → 用來決定要不要載入編輯工具 adminbar.js。 */
(function () {
  "use strict";
  if (window.__ipuaAccount) return;
  window.__ipuaAccount = 1;

  function cookie(name) {
    var m = (document.cookie || "").match(new RegExp("(?:^|;\\s*)" + name + "=([^;]*)"));
    return m ? decodeURIComponent(m[1]) : "";
  }
  var loggedInHint = cookie("ipua_auth") === "1";
  var adminHint = cookie("ipua_adm") === "1";
  var isLocal = /^(localhost|127\.)/.test(location.hostname);

  // 每次讀最新語言，右上角切換 EN/中 後帳號鈕跟著變
  function curLang() { try { return localStorage.getItem("ipua-lang") === "en" ? "en" : "zh"; } catch (e) { return "zh"; } }
  function tx(zh, en) { return curLang() === "en" ? en : zh; }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /* ===== 樣式 ===== */
  var css =
    // 登入鈕是 <a>，主站 index.html 的 .ctrl 沒有 flex 置中（那些是 <button>），會讓文字偏上 → 這裡補上
    "#acctLogin{display:inline-flex;align-items:center;justify-content:center;text-decoration:none}" +
    "#acctBtn{width:38px;height:38px;min-width:38px;padding:0;border-radius:50%;overflow:hidden;display:inline-flex;align-items:center;justify-content:center}" +
    "#acctBtn img{width:100%;height:100%;object-fit:cover;display:block}" +
    "#acctBtn.on{border-color:var(--line2)}" +
    ".acct-panel{position:fixed;z-index:75;min-width:220px;max-width:280px;background:var(--card);border:1px solid var(--line);border-radius:12px;box-shadow:0 10px 34px rgba(0,0,0,.2);padding:6px;display:none}" +
    ".acct-panel.open{display:block}" +
    ".acct-me{padding:11px 12px 9px}" +
    ".acct-me .nm{font-weight:700;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
    ".acct-me .em{font-size:12px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:1px}" +
    ".acct-badge{display:inline-block;font-size:10.5px;font-weight:700;border-radius:20px;padding:2px 9px;margin-top:7px;border:1px solid var(--line);color:var(--muted)}" +
    ".acct-badge.ok{background:var(--accent);color:var(--accent-fg);border-color:var(--line2)}" +
    ".acct-badge.warn{border-color:var(--line2);color:var(--fg)}" +
    ".acct-hr{border-top:1px solid var(--line);margin:6px 4px}" +
    ".acct-item{display:block;width:100%;text-align:left;padding:10px 12px;border:0;background:none;color:var(--fg);font-family:inherit;font-size:14px;font-weight:600;line-height:1.4;border-radius:8px;cursor:pointer;text-decoration:none;box-sizing:border-box}" +
    ".acct-item:hover{background:var(--field)}";
  var st = el("style"); st.textContent = css; document.head.appendChild(st);

  /* ===== 掛按鈕 ===== */
  function ctrls() { return document.querySelector("header .ctrls"); }

  function mountLogin() {
    var c = ctrls();
    if (!c || document.getElementById("acctBtn") || document.getElementById("acctLogin")) return;
    var a = el("a", "ctrl", tx("登入", "Sign in"));
    a.id = "acctLogin";
    a.href = "/auth/login?next=" + encodeURIComponent(location.pathname + location.search);
    c.insertBefore(a, c.firstChild);
  }

  var panel = null, btn = null, me = null;

  function mountAvatar(user) {
    me = user;
    var c = ctrls();
    if (!c) return;
    var old = document.getElementById("acctLogin"); if (old) old.remove();
    if (document.getElementById("acctBtn")) return;
    btn = el("button", "ctrl"); btn.id = "acctBtn"; btn.title = tx("帳號", "Account");
    btn.setAttribute("aria-label", tx("帳號", "Account"));
    var img = el("img"); img.alt = ""; img.referrerPolicy = "no-referrer";
    img.src = user.picture || avatarFallback(user.email);
    img.onerror = function () { img.src = avatarFallback(user.email); };
    btn.appendChild(img);
    c.insertBefore(btn, c.firstChild);
    btn.addEventListener("click", function (e) { e.stopPropagation(); togglePanel(); });
    document.addEventListener("click", function (e) { if (panel && panel.classList.contains("open") && !panel.contains(e.target)) closePanel(); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") closePanel(); });
    window.addEventListener("scroll", closePanel, { passive: true });
  }

  function avatarFallback(email) {
    var ch = (email || "?").charAt(0).toUpperCase();
    return "data:image/svg+xml," + encodeURIComponent(
      "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 40'><rect width='40' height='40' fill='#888'/><text x='20' y='27' font-size='20' fill='#fff' text-anchor='middle' font-family='sans-serif'>" + ch + "</text></svg>");
  }

  function buildPanel() {
    panel = el("div", "acct-panel");
    var head = el("div", "acct-me");
    head.appendChild(el("div", "nm", me.name || me.email));
    head.appendChild(el("div", "em", me.email));
    if (me.is_admin) head.appendChild(el("span", "acct-badge ok", tx("站長", "Admin")));
    else if (me.status === "approved") head.appendChild(el("span", "acct-badge", tx("已核准", "Approved")));
    else head.appendChild(el("span", "acct-badge warn", tx("待核准", "Pending")));
    panel.appendChild(head);
    panel.appendChild(el("div", "acct-hr"));

    // 純文字項目，不加前綴小圖示（站長 2026-07-14 要求全站拿掉這類裝飾）
    // 項目清單以站長指定為準，不要擅自加（LLM playground 曾被加過又被要求移除）
    function link(text, href) { var a = el("a", "acct-item", text); a.href = href; panel.appendChild(a); }
    link(tx("API 中轉站", "API relay"), "/relay");
    link(tx("VPN", "VPN"), "/vpn");
    if (me.is_admin) {
      panel.appendChild(el("div", "acct-hr"));
      link(tx("成員管理", "Members"), "/members");
      link(tx("文章管理", "Manage posts"), "/admin");
    }
    panel.appendChild(el("div", "acct-hr"));
    var out = el("button", "acct-item", tx("登出", "Sign out"));
    out.type = "button";
    out.addEventListener("click", logout);
    panel.appendChild(out);
    // 登出所有裝置（v1.0.0 計畫項目）：手機不見／公用電腦忘了登出時，一鍵撤銷全部 session
    var outAll = el("button", "acct-item", tx("登出所有裝置", "Sign out everywhere"));
    outAll.type = "button";
    outAll.addEventListener("click", function () {
      if (!confirm(tx("登出你在所有裝置上的登入狀態（包含這台）？", "Sign out on every device, including this one?"))) return;
      fetch("/api/account/logout-all", { method: "POST" })
        .then(function () { location.reload(); })
        .catch(function () { location.reload(); });
    });
    panel.appendChild(outAll);
    document.body.appendChild(panel);
  }
  function togglePanel() {
    if (!panel) buildPanel();
    if (panel.classList.contains("open")) { closePanel(); return; }
    var r = btn.getBoundingClientRect();
    panel.style.top = (r.bottom + 8) + "px";
    panel.style.right = Math.max(8, window.innerWidth - r.right) + "px";
    panel.classList.add("open"); btn.classList.add("on");
  }
  function closePanel() { if (panel) { panel.classList.remove("open"); if (btn) btn.classList.remove("on"); } }

  // 右上角切換 EN/中 時：登入鈕改字、頭像下拉重建（下次開啟就是新語言）
  function onLangChange() {
    var a = document.getElementById("acctLogin");
    if (a) a.textContent = tx("登入", "Sign in");
    if (btn) { btn.title = tx("帳號", "Account"); btn.setAttribute("aria-label", tx("帳號", "Account")); }
    if (panel) {
      var wasOpen = panel.classList.contains("open");
      panel.remove(); panel = null;
      if (wasOpen) togglePanel();
    }
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
        // 站長 → 載入側邊欄編輯工具（若還沒被 index.html/shell 的判斷載入）
        if (d.user.is_admin && !window.__ipuaAdminbar) {
          var s = document.createElement("script"); s.src = "/assets/adminbar.js?v=20260714"; document.head.appendChild(s);
        }
      } else {
        mountLogin();   // 提示 cookie 過期／session 失效
      }
    }).catch(function () { mountLogin(); });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
