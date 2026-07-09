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
