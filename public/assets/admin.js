/* admin.js — /admin 文章管理後台的行為（頁面外殼由 lib/site.js pageShell 輸出）。
   主題／語言／側邊欄由外殼腳本處理，這裡只管：金鑰閘門、文章列表、編輯器、圖片上傳、預覽。
   需要先載入 /assets/marked.js（Markdown 預覽用）。 */
(function(){
  "use strict";
  var $ = function(id){ return document.getElementById(id); };

  /* ===== 狀態 ===== */
  var token = "";
  try{ token = localStorage.getItem("ipua-logs-token") || ""; }catch(e){}
  // cur = 目前編輯中的文章；id 為 null 代表新文章還沒存過
  var cur = null;
  var MD_OPTS = { gfm:true, breaks:true, async:false };
  var CAT_PATH = { news:"/news", article:"/articles" };
  var CAT_LABEL = { news:"新聞", article:"文章" };

  /* ===== API ===== */
  function api(path, opts){
    opts = opts || {};
    opts.headers = opts.headers || {};
    if(token) opts.headers["Authorization"] = "Bearer " + token;
    if(opts.json !== undefined){
      opts.method = opts.method || "POST";
      opts.headers["content-type"] = "application/json";
      opts.body = JSON.stringify(opts.json);
      delete opts.json;
    }
    return fetch(path, opts).then(function(r){
      if(r.status === 401) throw { auth:true };
      return r.json().catch(function(){ return {}; }).then(function(d){
        if(!r.ok) throw new Error(d.hint || d.error || ("HTTP " + r.status));
        // 驗證通過就把金鑰記在這台裝置（含 ?edit= 直達的情況），下次免輸入
        try{ if(token) localStorage.setItem("ipua-logs-token", token); }catch(e){}
        return d;
      });
    });
  }

  /* ===== 畫面切換 ===== */
  function show(view, withErr){
    $("gate").classList.toggle("hidden", view !== "gate");
    $("listView").classList.toggle("hidden", view !== "list");
    $("editView").classList.toggle("hidden", view !== "edit");
    if(view === "gate"){
      $("gateErr").classList.toggle("hidden", !withErr);
      $("tokenInput").focus();
    }
  }

  /* ===== 列表 ===== */
  function fmtTime(iso){
    if(!iso) return "—";
    var d = new Date(iso);
    if(isNaN(d)) return iso;
    return d.toLocaleString("zh-TW", { month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit", hour12:false });
  }
  function el(tag, cls, text){
    var n = document.createElement(tag);
    if(cls) n.className = cls;
    if(text !== undefined && text !== null) n.textContent = text;
    return n;
  }
  function loadList(){
    api("/api/admin/articles").then(function(d){
      // 回到列表＝離開直達模式，把網址上的 ?edit= / ?new= 清掉（重新整理不會又跳回編輯器）
      try{ if(location.search) history.replaceState({}, "", "/admin"); }catch(e){}
      var tb = $("tbody"); tb.innerHTML = "";
      (d.rows || []).forEach(function(r){
        var tr = el("tr");
        var tdT = el("td"); tdT.appendChild(el("div", "t-title", r.title)); tr.appendChild(tdT);
        tr.appendChild(el("td", "nowrap", CAT_LABEL[r.category] || r.category));
        var tdS = el("td", "nowrap");
        tdS.appendChild(el("span", "chip" + (r.status === "published" ? " pub" : ""), r.status === "published" ? "已發佈" : "草稿"));
        tr.appendChild(tdS);
        tr.appendChild(el("td", "nowrap", String(r.views || 0)));
        tr.appendChild(el("td", "nowrap", fmtTime(r.published_at)));
        tr.addEventListener("click", function(){ openEdit(r.id); });
        tb.appendChild(tr);
      });
      $("listEmpty").classList.toggle("hidden", (d.rows || []).length > 0);
      show("list");
    }).catch(function(err){
      if(err && err.auth) show("gate", !!token);
      else alert("讀取失敗：" + (err.message || err));
    });
  }

  /* ===== 編輯器 ===== */
  function fillEditor(row){
    cur = row;
    $("fCat").value = row.category || "news";
    $("fTitle").value = row.title || "";
    $("fSummary").value = row.summary || "";
    $("fCover").value = row.cover || "";
    $("fBody").value = row.body_md || "";
    updateCover();
    renderPreview();
    updateButtons();
    $("msg").textContent = "";
    $("upMsg").textContent = "";
    show("edit");
    if(!row.id) $("fTitle").focus();
  }
  function openNew(cat){
    fillEditor({ id:null, category: cat === "article" ? "article" : "news", status:"draft", views:0 });
  }
  function openEdit(id){
    api("/api/admin/articles/" + id).then(function(d){ fillEditor(d.row); })
      .catch(function(err){
        if(err && err.auth) show("gate", true);
        else alert("讀取失敗：" + (err.message || err));
      });
  }
  function updateButtons(){
    var pub = cur.status === "published";
    $("editState").textContent = (cur.id ? "＃" + cur.id + " · " : "新文章 · ") + (pub ? "已發佈" : "草稿");
    $("saveBtn").textContent = pub ? "儲存變更" : "儲存草稿";
    $("pubBtn").textContent = pub ? "轉回草稿" : "發佈";
    $("delBtn").classList.toggle("hidden", !cur.id);
    var vl = $("viewLink");
    if(cur.id && pub){
      vl.href = (CAT_PATH[cur.category] || "/news") + "/" + cur.id;
      vl.classList.remove("hidden");
    } else vl.classList.add("hidden");
  }
  function collect(status){
    return {
      category: $("fCat").value === "article" ? "article" : "news",
      title: $("fTitle").value.trim(),
      summary: $("fSummary").value.trim(),
      cover: $("fCover").value.trim(),
      body_md: $("fBody").value,
      status: status
    };
  }
  function save(status){
    var data = collect(status);
    if(!data.title){ alert("標題不能是空的"); $("fTitle").focus(); return; }
    $("saveBtn").disabled = $("pubBtn").disabled = true;
    var req = cur.id
      ? api("/api/admin/articles/" + cur.id, { method:"PUT", json:data })
      : api("/api/admin/articles", { method:"POST", json:data });
    req.then(function(d){
      cur.id = cur.id || d.id;
      cur.status = data.status;
      cur.category = data.category;
      updateButtons();
      $("msg").textContent = data.status === "published" ? "✓ 已發佈" : "✓ 已儲存";
      setTimeout(function(){ $("msg").textContent = ""; }, 2500);
    }).catch(function(err){
      if(err && err.auth) show("gate", true);
      else alert("儲存失敗：" + (err.message || err));
    }).finally(function(){
      $("saveBtn").disabled = $("pubBtn").disabled = false;
    });
  }

  /* ===== 預覽 ===== */
  var pvTimer = null;
  function renderPreview(){
    var v = $("fBody").value;
    $("pv").innerHTML = v.trim() ? marked.parse(v, MD_OPTS) : '<p class="hint">開始輸入內文後這裡會即時預覽。</p>';
  }
  $("fBody").addEventListener("input", function(){
    clearTimeout(pvTimer);
    pvTimer = setTimeout(renderPreview, 250);
  });

  /* ===== 圖片：瀏覽器端壓縮 → 上傳 ===== */
  var MAX_UP = 1800000;   // 與伺服器一致（D1 單值上限 2MB，保守收 1.8MB）
  function compressImage(file){
    return new Promise(function(resolve, reject){
      if(!/^image\//.test(file.type)) return reject(new Error("請選擇圖片檔"));
      // GIF 重壓會失去動畫：小於上限就原樣上傳
      if(file.type === "image/gif" && file.size <= MAX_UP) return resolve({ blob:file, w:0, h:0 });
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function(){
        var MAXW = 1600, w = img.naturalWidth, h = img.naturalHeight;
        var s = Math.min(1, MAXW / w);
        var cw = Math.max(1, Math.round(w * s)), ch = Math.max(1, Math.round(h * s));
        var cv = document.createElement("canvas"); cv.width = cw; cv.height = ch;
        cv.getContext("2d").drawImage(img, 0, 0, cw, ch);
        URL.revokeObjectURL(url);
        var attempt = function(type, q, next){
          cv.toBlob(function(b){
            if(b && b.size <= MAX_UP) return resolve({ blob:b, w:cw, h:ch });
            next();
          }, type, q);
        };
        // webp 0.82 → webp 0.6 → jpeg 0.8 → 縮到 1000px jpeg 0.7 → 放棄
        attempt("image/webp", 0.82, function(){
          attempt("image/webp", 0.6, function(){
            attempt("image/jpeg", 0.8, function(){
              var s2 = Math.min(1, 1000 / cw);
              var c2 = document.createElement("canvas");
              c2.width = Math.max(1, Math.round(cw * s2)); c2.height = Math.max(1, Math.round(ch * s2));
              c2.getContext("2d").drawImage(cv, 0, 0, c2.width, c2.height);
              c2.toBlob(function(b2){
                if(b2 && b2.size <= MAX_UP) resolve({ blob:b2, w:c2.width, h:c2.height });
                else reject(new Error("這張圖壓不進 1.8MB，請換一張"));
              }, "image/jpeg", 0.7);
            });
          });
        });
      };
      img.onerror = function(){ URL.revokeObjectURL(url); reject(new Error("圖片無法讀取")); };
      img.src = url;
    });
  }
  function upload(file, onDone){
    $("upMsg").textContent = "壓縮中…";
    compressImage(file).then(function(r){
      $("upMsg").textContent = "上傳中…（" + Math.round(r.blob.size / 1024) + " KB）";
      var headers = { "content-type": r.blob.type || "image/webp" };
      if(token) headers["Authorization"] = "Bearer " + token;
      return fetch("/api/admin/media?w=" + r.w + "&h=" + r.h, { method:"POST", headers:headers, body:r.blob })
        .then(function(resp){
          if(resp.status === 401) throw { auth:true };
          return resp.json().then(function(d){
            if(!resp.ok) throw new Error(d.hint || d.error || ("HTTP " + resp.status));
            return d;
          });
        });
    }).then(function(d){
      $("upMsg").textContent = "✓ 已上傳";
      setTimeout(function(){ $("upMsg").textContent = ""; }, 2000);
      onDone(d);
    }).catch(function(err){
      $("upMsg").textContent = "";
      if(err && err.auth) show("gate", true);
      else alert("上傳失敗：" + (err.message || err));
    });
  }
  function pickFile(onPick){
    var inp = document.createElement("input");
    inp.type = "file"; inp.accept = "image/*";
    inp.addEventListener("change", function(){ if(inp.files && inp.files[0]) onPick(inp.files[0]); });
    inp.click();
  }
  function updateCover(){
    var v = $("fCover").value.trim();
    $("coverPrev").classList.toggle("hidden", !v);
    if(v) $("coverPrev").src = v;
  }
  function insertAtCursor(ta, text){
    var s = ta.selectionStart || 0, e = ta.selectionEnd || 0, v = ta.value;
    ta.value = v.slice(0, s) + text + v.slice(e);
    ta.selectionStart = ta.selectionEnd = s + text.length;
    renderPreview();
    ta.focus();
  }

  /* ===== 綁定 ===== */
  $("gateForm").addEventListener("submit", function(e){
    e.preventDefault();
    token = $("tokenInput").value.trim();
    if(token) boot();   // 金鑰對了會回到原本要去的地方（含 ?edit= / ?new= 直達）
  });
  $("newBtn").addEventListener("click", function(){ openNew(); });
  $("reloadBtn").addEventListener("click", loadList);
  $("logoutBtn").addEventListener("click", function(){
    token = "";
    try{ localStorage.removeItem("ipua-logs-token"); }catch(e){}
    show("gate", false);
  });
  $("backBtn").addEventListener("click", loadList);
  $("saveBtn").addEventListener("click", function(){ save(cur.status); });
  $("pubBtn").addEventListener("click", function(){ save(cur.status === "published" ? "draft" : "published"); });
  $("delBtn").addEventListener("click", function(){
    if(!cur.id) return;
    if(!confirm("確定要刪除「" + ($("fTitle").value || "未命名") + "」嗎？刪了就找不回來。")) return;
    api("/api/admin/articles/" + cur.id, { method:"DELETE" }).then(loadList).catch(function(err){
      if(err && err.auth) show("gate", true);
      else alert("刪除失敗：" + (err.message || err));
    });
  });
  $("fCover").addEventListener("input", updateCover);
  $("coverBtn").addEventListener("click", function(){
    pickFile(function(f){ upload(f, function(d){ $("fCover").value = d.url; updateCover(); }); });
  });
  $("coverClear").addEventListener("click", function(){ $("fCover").value = ""; updateCover(); });
  $("imgBtn").addEventListener("click", function(){
    pickFile(function(f){
      upload(f, function(d){ insertAtCursor($("fBody"), "\n![圖片說明](" + d.url + ")\n"); });
    });
  });

  // 網址直達（✎ 編輯模式用）：/admin?edit=12 直接開該篇編輯器、/admin?new=article 直接寫新文章；
  // 沒帶參數＝照舊進列表。金鑰不對會先出現驗證畫面，過了再繼續。
  function boot(){
    var q = location.search || "";
    var em = q.match(/[?&]edit=(\d+)/);
    var nm = q.match(/[?&]new=(news|article)/);
    if(em) openEdit(parseInt(em[1], 10));
    else if(nm) openNew(nm[1]);
    else loadList();
  }
  boot();
})();
