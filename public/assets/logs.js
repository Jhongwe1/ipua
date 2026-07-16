/* logs.js — /logs 訪客紀錄頁的行為（頁面外殼由 lib/site.js pageShell 輸出）。
   主題／語言／側邊欄都由外殼腳本處理，這裡只管：金鑰閘門、查 /api/logs、畫表格。 */
(function(){
  "use strict";
  var $ = function(id){ return document.getElementById(id); };

  /* ===== 狀態 ===== */
  var LIMIT = 50;
  var token = "";
  try{ token = localStorage.getItem("ipua-logs-token") || ""; }catch(e){}
  var offset = 0, q = "", loading = false;

  /* ===== 小工具 ===== */
  function el(tag, cls, text){
    var n = document.createElement(tag);
    if(cls) n.className = cls;
    if(text !== undefined && text !== null) n.textContent = text;
    return n;
  }
  function fmtTime(iso){
    var d = new Date(iso);
    if(isNaN(d)) return iso || "—";
    var now = new Date();
    var opt = { month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit", second:"2-digit", hour12:false };
    if(d.getFullYear() !== now.getFullYear()) opt.year = "numeric";
    return d.toLocaleString("zh-TW", opt);
  }
  function countryName(code){
    if(!code) return "";
    try{
      if(window.Intl && Intl.DisplayNames){
        var n = new Intl.DisplayNames(["zh-Hant"], { type:"region" }).of(code);
        if(n && n !== code) return n + " (" + code + ")";
      }
    }catch(e){}
    return code;
  }
  // 迷你 UA 解析：列表顯示「Chrome 138 · Windows」這種摘要，完整字串在展開列
  function uaBrief(ua){
    if(!ua) return "—";
    var m, name = "", os = "";
    if((m = ua.match(/Edg(?:e|A|iOS)?\/([\d.]+)/)))      name = "Edge " + m[1].split(".")[0];
    else if((m = ua.match(/OPR\/([\d.]+)/)))             name = "Opera " + m[1].split(".")[0];
    else if((m = ua.match(/SamsungBrowser\/([\d.]+)/)))  name = "Samsung " + m[1].split(".")[0];
    else if((m = ua.match(/CriOS\/([\d.]+)/)))           name = "Chrome iOS " + m[1].split(".")[0];
    else if((m = ua.match(/FxiOS\/([\d.]+)/)))           name = "Firefox iOS " + m[1].split(".")[0];
    else if((m = ua.match(/Firefox\/([\d.]+)/)))         name = "Firefox " + m[1].split(".")[0];
    else if((m = ua.match(/Chrome\/([\d.]+)/)))          name = "Chrome " + m[1].split(".")[0];
    else if((m = ua.match(/Version\/([\d.]+).*Safari/))) name = "Safari " + m[1].split(".")[0];
    else if(/bot|crawl|spider|preview|fetch|curl|wget|python|http/i.test(ua)) name = "Bot / 工具";
    if(/Windows NT 10\.0/.test(ua)) os = "Windows";
    else if(/Windows/.test(ua))     os = "Windows";
    else if(/Android/.test(ua))     os = "Android";
    else if(/iPhone|iPad|iPod/.test(ua)) os = "iOS";
    else if(/Mac OS X/.test(ua))    os = "macOS";
    else if(/Linux/.test(ua))       os = "Linux";
    if(!name && !os) return "";
    return name + (name && os ? " · " : "") + os;
  }
  function sinceToday(){
    var d = new Date(); d.setHours(0,0,0,0);   // 本地（台灣）今天零點 → 轉成 UTC ISO 給伺服器比對
    return d.toISOString();
  }

  /* ===== API ===== */
  function api(params){
    var qs = "limit=" + LIMIT + "&offset=" + params.offset +
             "&since=" + encodeURIComponent(sinceToday()) +
             (params.q ? "&q=" + encodeURIComponent(params.q) : "");
    var headers = token ? { "Authorization": "Bearer " + token } : {};
    return fetch("/api/logs?" + qs, { headers: headers, cache: "no-store" })
      .then(function(r){
        if(r.status === 401) throw { auth: true };
        if(!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      });
  }

  /* ===== 畫面 ===== */
  function showGate(withErr){
    $("gate").classList.remove("hidden");
    $("main").classList.add("hidden");
    $("gateErr").classList.toggle("hidden", !withErr);
    $("tokenInput").focus();
  }
  function showMain(){
    $("gate").classList.add("hidden");
    $("main").classList.remove("hidden");
  }

  var DETAIL_FIELDS = [
    ["完整 UA", function(r){ return r.ua; }],
    ["ISP", function(r){ return (r.isp || "") + (r.asn ? " (AS" + r.asn + ")" : ""); }],
    ["地區", function(r){ return [r.city, r.region, countryName(r.country)].filter(Boolean).join(" · "); }],
    ["語言標頭", function(r){ return r.lang; }],
    ["來源頁", function(r){ return r.referer; }],
    ["CF 節點", function(r){ return r.colo; }],
    ["連線", function(r){ return [r.http, r.tls].filter(Boolean).join(" · "); }],
    ["主機", function(r){ return r.host; }],
    ["方法", function(r){ return r.method; }],
    ["編號", function(r){ return "#" + r.id; }]
  ];

  function renderRow(r){
    var tr = el("tr", "main");
    var tdT = el("td", "nowrap mono", fmtTime(r.ts)); tdT.title = r.ts;
    tr.appendChild(tdT);
    tr.appendChild(el("td", "mono", r.ip || "—"));
    var geo = [r.country || "", r.city || ""].filter(Boolean).join(" · ");
    tr.appendChild(el("td", "nowrap", geo || "—"));
    tr.appendChild(el("td", "mono", r.path || "—"));
    var tdU = el("td");
    var brief = uaBrief(r.ua);
    if(brief) tdU.appendChild(el("div", "ua-name", brief));
    var line = el("div", "ua-line mono", r.ua || "—"); line.title = r.ua || "";
    tdU.appendChild(line);
    tr.appendChild(tdU);

    var detail = null;
    tr.addEventListener("click", function(){
      if(detail){ detail.remove(); detail = null; return; }
      detail = el("tr", "detail");
      var td = document.createElement("td"); td.colSpan = 5;
      var kv = el("div", "kv");
      DETAIL_FIELDS.forEach(function(f){
        var v = f[1](r);
        if(v === undefined || v === null || v === "") return;
        kv.appendChild(el("span", "k", f[0]));
        kv.appendChild(el("span", "v mono", String(v)));
      });
      td.appendChild(kv); detail.appendChild(td);
      tr.parentNode.insertBefore(detail, tr.nextSibling);
    });
    return tr;
  }

  function load(reset){
    if(loading) return;
    loading = true;
    if(reset){ offset = 0; }
    api({ offset: offset, q: q }).then(function(d){
      if(reset) $("tbody").innerHTML = "";
      (d.rows || []).forEach(function(r){ $("tbody").appendChild(renderRow(r)); });
      offset += (d.rows || []).length;
      $("stTotal").textContent = (d.total != null) ? d.total.toLocaleString() : "—";
      $("stToday").textContent = (d.today != null) ? d.today.toLocaleString() : "—";
      $("stTodayIps").textContent = (d.todayIps != null) ? d.todayIps.toLocaleString() : "—";
      $("empty").classList.toggle("hidden", $("tbody").children.length > 0);
      $("moreBtn").classList.toggle("hidden", offset >= d.total || (d.rows || []).length < LIMIT);
      showMain();
      try{ if(token) localStorage.setItem("ipua-logs-token", token); }catch(e){}
      loading = false;
    }).catch(function(err){
      loading = false;
      if(err && err.auth){ showGate(!!token); return; }
      $("empty").textContent = "讀取失敗，請稍後再試。";
      $("empty").classList.remove("hidden");
      showMain();
    });
  }

  /* ===== 分頁 2：站內錯誤（/api/admin/errors） ===== */
  var errOffset = 0, errLoading = false, errLoaded = false;

  function adminApi(path, opts){
    opts = opts || {};
    opts.headers = token ? { "Authorization": "Bearer " + token } : {};
    opts.cache = "no-store";
    return fetch(path, opts).then(function(r){
      if(r.status === 401) throw { auth: true };
      if(!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    });
  }

  function renderErrRow(r){
    var tr = el("tr", "main");
    var tdT = el("td", "nowrap mono", fmtTime(r.ts)); tdT.title = r.ts;
    tr.appendChild(tdT);
    tr.appendChild(el("td", "mono nowrap", r.src || "—"));
    var tdM = el("td");
    var line = el("div", "ua-line mono", r.msg || "—"); line.title = r.msg || "";
    line.style.maxWidth = "420px";
    tdM.appendChild(line);
    tr.appendChild(tdM);
    tr.appendChild(el("td", "mono", r.path || "—"));
    var detail = null;
    tr.addEventListener("click", function(){
      if(detail){ detail.remove(); detail = null; return; }
      detail = el("tr", "detail");
      var td = document.createElement("td"); td.colSpan = 4;
      var kv = el("div", "kv");
      [["訊息", r.msg], ["細節", r.detail], ["會員編號", r.user_id], ["編號", "#" + r.id]].forEach(function(f){
        if(f[1] === undefined || f[1] === null || f[1] === "") return;
        kv.appendChild(el("span", "k", f[0]));
        kv.appendChild(el("span", "v mono", String(f[1])));
      });
      td.appendChild(kv); detail.appendChild(td);
      tr.parentNode.insertBefore(detail, tr.nextSibling);
    });
    return tr;
  }

  function loadErrors(reset){
    if(errLoading) return;
    errLoading = true;
    if(reset) errOffset = 0;
    adminApi("/api/admin/errors?limit=" + LIMIT + "&offset=" + errOffset).then(function(d){
      if(reset) $("errBody").innerHTML = "";
      (d.rows || []).forEach(function(r){ $("errBody").appendChild(renderErrRow(r)); });
      errOffset += (d.rows || []).length;
      $("errEmpty").classList.toggle("hidden", $("errBody").children.length > 0);
      $("errMoreBtn").classList.toggle("hidden", errOffset >= d.total || (d.rows || []).length < LIMIT);
      errLoading = false; errLoaded = true;
    }).catch(function(err){
      errLoading = false;
      if(err && err.auth){ showGate(!!token); return; }
      $("errEmpty").textContent = "讀取失敗，請稍後再試。";
      $("errEmpty").classList.remove("hidden");
    });
  }

  /* ===== 分頁 3：用量統計（/api/admin/stats） ===== */
  var statDays = 7, statLoaded = false;

  function pct(sorted, p){
    if(!sorted.length) return null;
    var i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
    return sorted[i];
  }
  function numFmt(n){ return (n == null) ? "—" : Number(n).toLocaleString(); }
  /* 成本顯示（估算值）：null＝未定價「—」；有值固定 4 位小數美元 */
  function costFmt(c){ return (c == null) ? "—" : "$" + Number(c).toFixed(4); }

  function loadStats(){
    adminApi("/api/admin/stats?days=" + statDays).then(function(d){
      var total = 0, errs = 0, tin = 0, tout = 0;
      (d.by_day || []).forEach(function(r){
        total += r.n || 0; errs += r.errs || 0;
        tin += r.tokens_in || 0; tout += r.tokens_out || 0;
      });
      $("uTotal").textContent = numFmt(total);
      $("uErrs").textContent = numFmt(errs);
      var durs = (d.durs || []).map(function(x){ return x.dur_ms; }).filter(function(x){ return x != null; }).sort(function(a,b){ return a-b; });
      $("uP50").textContent = numFmt(pct(durs, .5));
      $("uP95").textContent = numFmt(pct(durs, .95));
      $("uTokens").textContent = numFmt(tin) + " / " + numFmt(tout);
      $("uCost").textContent = costFmt(d.cost_total);

      /* 未定價模型提示：補進 /api/admin/prices 之後成本欄才有數字 */
      var un = d.unpriced_models || [];
      $("unpricedNote").textContent = un.length
        ? "⚠ 有模型還沒定價（成本欄顯示 —）：" + un.join("、") + "。用 PUT /api/admin/prices 補上即可。"
        : "";
      $("unpricedNote").classList.toggle("hidden", un.length === 0);

      var cb = $("chBody"); cb.innerHTML = "";
      (d.by_channel || []).forEach(function(r){
        var tr = el("tr");
        tr.appendChild(el("td", "mono", r.svc));
        tr.appendChild(el("td", "mono", r.channel || "—"));
        tr.appendChild(el("td", "mono", r.model || "—"));
        tr.appendChild(el("td", null, numFmt(r.n)));
        tr.appendChild(el("td", null, numFmt(r.errs)));
        tr.appendChild(el("td", null, numFmt(r.avg_dur)));
        tr.appendChild(el("td", null, numFmt(r.avg_ttfb)));
        tr.appendChild(el("td", "mono", numFmt(r.tokens_in) + " / " + numFmt(r.tokens_out)));
        tr.appendChild(el("td", "mono", costFmt(r.cost)));
        cb.appendChild(tr);
      });
      $("chEmpty").classList.toggle("hidden", cb.children.length > 0);

      var ub = $("userBody"); ub.innerHTML = "";
      (d.by_user || []).forEach(function(r){
        var tr = el("tr");
        var who = (r.name || r.email || ("#" + r.user_id)) + (r.email && r.name ? "（" + r.email + "）" : "");
        tr.appendChild(el("td", null, who));
        tr.appendChild(el("td", null, numFmt(r.n)));
        tr.appendChild(el("td", "mono", numFmt(r.tokens_in) + " / " + numFmt(r.tokens_out)));
        tr.appendChild(el("td", "mono", costFmt(r.cost) + (r.unpriced ? " ⚠" : "")));
        ub.appendChild(tr);
      });
      $("userEmpty").classList.toggle("hidden", ub.children.length > 0);

      var db = $("dayBody"); db.innerHTML = "";
      (d.by_day || []).forEach(function(r){
        var tr = el("tr");
        tr.appendChild(el("td", "mono", r.d));
        tr.appendChild(el("td", "mono", r.svc));
        tr.appendChild(el("td", null, numFmt(r.n)));
        tr.appendChild(el("td", null, numFmt(r.errs)));
        tr.appendChild(el("td", null, numFmt(r.avg_dur)));
        tr.appendChild(el("td", "mono", numFmt(r.tokens_in) + " / " + numFmt(r.tokens_out)));
        db.appendChild(tr);
      });
      statLoaded = true;
    }).catch(function(err){
      if(err && err.auth){ showGate(!!token); return; }
    });
  }

  /* ===== 分頁切換 ===== */
  function switchTab(name){
    [["Visits", "tabVisits", "paneVisits"], ["Errors", "tabErrors", "paneErrors"], ["Stats", "tabStats", "paneStats"]].forEach(function(t){
      var on = t[0] === name;
      $(t[1]).classList.toggle("on", on);
      $(t[2]).classList.toggle("hidden", !on);
    });
    if(name === "Errors" && !errLoaded) loadErrors(true);
    if(name === "Stats" && !statLoaded) loadStats();
  }
  $("tabVisits").addEventListener("click", function(){ switchTab("Visits"); });
  $("tabErrors").addEventListener("click", function(){ switchTab("Errors"); });
  $("tabStats").addEventListener("click", function(){ switchTab("Stats"); });

  $("errRefreshBtn").addEventListener("click", function(){ loadErrors(true); });
  $("errMoreBtn").addEventListener("click", function(){ loadErrors(false); });
  $("errClearBtn").addEventListener("click", function(){
    if(!confirm("清空全部錯誤紀錄？此動作無法復原。")) return;
    adminApi("/api/admin/errors", { method: "DELETE" }).then(function(){ loadErrors(true); })
      .catch(function(){ alert("清空失敗，請稍後再試。"); });
  });
  Array.prototype.forEach.call(document.querySelectorAll(".dayBtn"), function(b){
    b.addEventListener("click", function(){
      Array.prototype.forEach.call(document.querySelectorAll(".dayBtn"), function(x){ x.classList.remove("on"); });
      b.classList.add("on");
      statDays = parseInt(b.getAttribute("data-days"), 10) || 7;
      loadStats();
    });
  });

  /* ===== 綁定 ===== */
  $("gateForm").addEventListener("submit", function(e){
    e.preventDefault();
    token = $("tokenInput").value.trim();
    if(token) load(true);
  });
  $("searchForm").addEventListener("submit", function(e){
    e.preventDefault();
    q = $("qInput").value.trim();
    load(true);
  });
  $("refreshBtn").addEventListener("click", function(){ load(true); });
  $("moreBtn").addEventListener("click", function(){ load(false); });
  $("logoutBtn").addEventListener("click", function(){
    token = "";
    try{ localStorage.removeItem("ipua-logs-token"); }catch(e){}
    showGate(false);
  });

  load(true);   // 有存過金鑰就直接進；沒有或錯誤 → 顯示驗證畫面
})();
