// GET /playground — LLM Playground（會員頁）。
// 未登入 → 登入閘門；沒被批准 playground 服務 → 等待批准畫面；批准後是完整聊天介面：
// 選模型（站長在 /relay 渠道裡設定的清單）、串流回覆、新對話、歷史對話（存 D1、跨裝置）、
// 改名／刪除、Markdown 渲染（含程式碼複製）。桌機左側常駐對話列表；手機收成抽屜。
// 後端邏輯在 lib/playground.js 與 functions/api/playground/*。
import { html, pageShell, getChrome } from "./site.js";
import { MEMBER_CSS, MEMBER_JS } from "./memberui.js";

const PG_CSS = `
  .wrap{max-width:1080px}
  footer{display:none}
  /* 邊界強化（維持黑白）：本頁專用的深一階分隔線＋卡片陰影＋聚焦光圈；
     頁面底色退一階灰，白色聊天框靠陰影跳出來（暗色模式反過來：框比底更深） */
  :root{--pgline:#d4d4d4;--pgring:rgba(17,17,17,.08);--pgshadow:0 1px 2px rgba(0,0,0,.05),0 12px 32px rgba(0,0,0,.08);background:var(--field)}
  [data-theme="dark"]{--pgline:#3a3a3a;--pgring:rgba(244,244,244,.14);--pgshadow:0 1px 2px rgba(0,0,0,.5),0 12px 32px rgba(0,0,0,.45)}
  /* 這段樣式排在外殼樣式「前面」，所以 body 要用 html body 拉高權重才蓋得過外殼的 html,body 規則。
     聊天框吃滿到接近視窗底邊：頁尾隱藏＋body 底部留白縮小，高度只扣頁首那一段 */
  html body{background:var(--field);padding-bottom:14px}
  .pg{position:relative;display:flex;border:1px solid var(--pgline);border-radius:16px;background:var(--card);overflow:hidden;box-shadow:var(--pgshadow);
      height:calc(100vh - 98px);height:calc(100dvh - 98px);min-height:420px}
  /* ---- 左側：對話列表 ---- */
  .pg-side{width:248px;flex:0 0 248px;border-right:1px solid var(--pgline);display:flex;flex-direction:column;min-width:0;background:var(--field)}
  .pg-new{padding:10px}
  .pg-newbtn{width:100%;border:1px solid var(--line2);background:var(--accent);color:var(--accent-fg);border-radius:9px;
             padding:10px 12px;font-size:13.5px;font-weight:700;cursor:pointer;font-family:inherit}
  .pg-convs{flex:1;overflow-y:auto;padding:0 8px 12px}
  .pg-empty{padding:14px 8px;font-size:12.5px;color:var(--muted);text-align:center}
  .pg-conv{display:flex;align-items:center;gap:2px;padding:8px 6px 8px 10px;border-radius:8px;cursor:pointer;color:var(--fg)}
  .pg-conv:hover{background:var(--card)}
  .pg-conv.on{background:var(--accent);color:var(--accent-fg)}
  .pg-conv .tt{flex:1;min-width:0;font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .pg-conv .ic{flex:0 0 auto;border:0;background:none;color:inherit;cursor:pointer;font-size:12px;line-height:1;
               padding:4px 5px;border-radius:5px;opacity:0;font-family:inherit}
  .pg-conv:hover .ic{opacity:.6}
  .pg-conv .ic:hover{opacity:1;background:rgba(128,128,128,.18)}
  @media(hover:none){.pg-conv .ic{opacity:.5}}
  /* ---- 右側：對話主區 ---- */
  .pg-main{flex:1;display:flex;flex-direction:column;min-width:0}
  .pg-top{display:flex;align-items:center;gap:8px;padding:9px 12px;border-bottom:1px solid var(--pgline)}
  .pg-top select{border:1px solid var(--pgline);background:var(--field);color:var(--fg);border-radius:8px;padding:8px 10px;
                 font-size:13px;font-weight:400;font-family:inherit;outline:none;max-width:100%;min-width:0;transition:.15s}
  .pg-top select:focus{border-color:var(--line2);box-shadow:0 0 0 3px var(--pgring)}
  .pg-histbtn{display:none;border:1px solid var(--pgline);background:var(--card);color:var(--fg);border-radius:8px;
              padding:8px 11px;font-size:13px;cursor:pointer;font-family:inherit;flex:0 0 auto}
  .pg-msgs{flex:1;overflow-y:auto;padding:18px 16px 10px;display:flex;flex-direction:column;gap:16px}
  /* 細滾動條（黑白） */
  .pg-msgs::-webkit-scrollbar,.pg-convs::-webkit-scrollbar{width:8px}
  .pg-msgs::-webkit-scrollbar-track,.pg-convs::-webkit-scrollbar-track{background:transparent}
  .pg-msgs::-webkit-scrollbar-thumb,.pg-convs::-webkit-scrollbar-thumb{background:var(--line);border-radius:4px;border:2px solid transparent;background-clip:content-box}
  .pg-msgs::-webkit-scrollbar-thumb:hover,.pg-convs::-webkit-scrollbar-thumb:hover{background:var(--pgline);background-clip:content-box}
  .m{width:100%;max-width:780px;margin:0 auto;flex:0 0 auto}
  .m.user{display:flex;justify-content:flex-end}
  .mb-user{background:var(--accent);color:var(--accent-fg);border-radius:16px 16px 4px 16px;padding:9px 14px;max-width:84%;
           font-size:14.5px;line-height:1.7;white-space:pre-wrap;overflow-wrap:anywhere}
  .m.ai .who{font-size:10.5px;font-weight:700;letter-spacing:.07em;color:var(--muted);text-transform:uppercase;margin-bottom:5px}
  .m.ai .md{font-size:15px;line-height:1.85;overflow-wrap:anywhere;min-width:0}
  .m-act{margin-top:6px}
  .mab{border:1px solid var(--line);background:transparent;color:var(--muted);border-radius:7px;padding:4px 10px;
       font-size:11.5px;font-weight:600;cursor:pointer;font-family:inherit;transition:.15s}
  .mab:hover{border-color:var(--line2);color:var(--fg)}
  .m-err{color:#c33;font-size:13px;border:1px solid rgba(204,51,51,.5);border-radius:8px;padding:8px 12px;margin-top:8px}
  /* Markdown（AI 回覆） */
  .md p{margin:0 0 .85em}
  .md>:last-child{margin-bottom:0}
  .md h1,.md h2{font-size:18px;line-height:1.5;margin:1.1em 0 .5em}
  .md h3,.md h4{font-size:16px;margin:1em 0 .45em}
  .md ul,.md ol{padding-left:1.6em;margin:0 0 .85em}
  .md li{margin:.22em 0}
  .md blockquote{border-left:3px solid var(--line2);padding:2px 0 2px 13px;color:var(--muted);margin:0 0 .85em}
  .md code{font-family:ui-monospace,Menlo,Consolas,monospace;background:var(--field);border:1px solid var(--line);border-radius:5px;padding:1px 5px;font-size:.86em}
  .md pre{position:relative;background:var(--field);border:1px solid var(--line);border-radius:10px;padding:12px;
          overflow-x:auto;margin:0 0 .9em;line-height:1.6;font-size:13px}
  .md pre code{border:0;background:none;padding:0;font-size:inherit}
  .md pre .cpb{position:absolute;top:6px;right:6px;border:1px solid var(--line);background:var(--card);color:var(--muted);
               border-radius:6px;padding:3px 8px;font-size:11px;font-weight:600;cursor:pointer;font-family:inherit;opacity:0;transition:.15s}
  .md pre:hover .cpb{opacity:1}
  @media(hover:none){.md pre .cpb{opacity:.7}}
  .md hr{border:0;border-top:1px solid var(--line);margin:1.2em 0}
  .md table{border-collapse:collapse;margin:0 0 .9em;max-width:100%;display:block;overflow-x:auto}
  .md th,.md td{border:1px solid var(--line);padding:5px 10px;font-size:13.5px}
  .md a{color:var(--fg)}
  .md img{max-width:100%;height:auto;border-radius:8px}
  /* 等待中的三顆點 */
  .dots{display:inline-flex;gap:4px;padding:8px 0}
  .dots i{width:6px;height:6px;border-radius:50%;background:var(--muted);animation:pgb 1s infinite}
  .dots i:nth-child(2){animation-delay:.15s}
  .dots i:nth-child(3){animation-delay:.3s}
  @keyframes pgb{0%,60%,100%{opacity:.25;transform:none}30%{opacity:1;transform:translateY(-3px)}}
  /* 空狀態（只剩「還沒設定模型」的提醒會用到） */
  .pg-hero{margin:auto;text-align:center;padding:22px 16px;max-width:520px}
  .pg-hero p{font-size:13.5px;color:var(--muted);line-height:1.75;margin:0}
  /* 輸入區 */
  .pg-comp{border-top:1px solid var(--pgline);padding:10px 12px;display:flex;gap:8px;align-items:flex-end}
  /* overflow-y 平常藏起來（min-height 只比一行內容多一點點，差 1px 就會擠出整組 Windows 捲軸箭頭），
     長文超過 max-height 時才由 autoGrow 把它切回 auto */
  .pg-ta{flex:1;resize:none;border:1px solid var(--pgline);background:var(--field);color:var(--fg);border-radius:13px;
         padding:10px 14px;font-size:14.5px;font-family:inherit;line-height:1.6;outline:none;min-height:44px;max-height:160px;box-sizing:border-box;overflow-y:hidden;transition:border-color .15s,box-shadow .15s}
  .pg-ta:focus{border-color:var(--line2);box-shadow:0 0 0 3px var(--pgring)}
  .pg-send{width:42px;height:42px;flex:0 0 auto;border-radius:50%;border:1px solid var(--line2);background:var(--accent);
           color:var(--accent-fg);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;font-family:inherit;transition:.15s}
  .pg-send svg{display:block}
  .pg-send:not(:disabled):active{transform:translateY(1px)}
  .pg-send:disabled{opacity:.35;cursor:default}
  .pg-send.stop{background:transparent;color:var(--fg);border-color:var(--line)}
  /* 手機：側欄變抽屜 */
  .pg-ovl{display:none;position:absolute;inset:0;background:rgba(0,0,0,.4);z-index:4}
  @media(max-width:839.98px){
    .pg-side{position:absolute;top:0;left:0;bottom:0;z-index:5;transform:translateX(-105%);transition:transform .2s ease;box-shadow:0 0 34px rgba(0,0,0,.28)}
    .pg.open .pg-side{transform:none}
    .pg.open .pg-ovl{display:block}
    .pg-histbtn{display:inline-flex}
    .mb-user{max-width:92%}
  }
  @media(max-width:480px){
    html body{padding-bottom:10px}
    .pg{height:calc(100vh - 88px);height:calc(100dvh - 88px);min-height:360px}
  }
  /* 觸控裝置：輸入框字級 <16px 時 iOS Safari 聚焦會自動放大整頁 — 拉到 16px 就不會 */
  @media(hover:none){
    .pg-ta{font-size:16px}
    .pg-top select{font-size:16px}
  }
`;

export async function playgroundPageResponse(env) {
  const chrome = await getChrome(env);
  const body =
    '<div id="root"><div class="gate"><div class="spin"></div></div></div>\n' +
    '<script src="/assets/marked.js"></script>\n' +
    '<script>' + MEMBER_JS + '</script>\n' +
    '<script>' + PG_JS + '</script>';
  return html(pageShell({
    title: "LLM playground",
    tkey: "page.playground",
    desc: "會員專用的 LLM playground — 在網頁上直接試用站上的 AI 模型。",
    noindex: true,
    chrome: chrome,
    activePath: "/playground",
    h1: '<a href="/">LLM playground</a>',
    // 蓋掉外殼的 viewport（後出現者生效）：鎖 maximum-scale，手機點輸入框不會自動放大頁面
    headExtra: '<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">\n' +
      "<style>" + MEMBER_CSS + PG_CSS + "</style>\n",
    body: body
  }));
}

const PG_JS = `
(function(){
  "use strict";
  var $=MU.$,el=MU.el,tx=MU.tx,esc=MU.esc;
  var root=$("root");
  // 送出／停止圖示（SVG 線條箭頭與圓角方塊，比文字字元俐落）
  var SEND_ICON='<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';
  var STOP_ICON='<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="3"/></svg>';
  var me=null,groups=[],convs=[],cur=null,msgs=[];
  var streaming=false,aborter=null;
  var UI={};
  var coarse=!!(window.matchMedia&&matchMedia("(pointer:coarse)").matches);

  function api(path,opts){
    opts=opts||{};opts.headers=opts.headers||{};
    if(opts.json!==undefined){opts.method=opts.method||"POST";opts.headers["content-type"]="application/json";opts.body=JSON.stringify(opts.json);delete opts.json;}
    if(!opts.cache)opts.cache="no-store";
    return fetch(path,opts).then(function(r){
      return r.json().catch(function(){return{};}).then(function(d){
        if(!r.ok)throw new Error(d.hint||d.error||("HTTP "+r.status));
        return d;
      });
    });
  }
  function hasSvc(){return !!(me&&(me.services||[]).indexOf("playground")>=0);}

  /* ================= Markdown（含消毒）================= */
  function textHtml(t){return esc(t).replace(/\\n/g,"<br>");}
  function sanitize(rootNode){
    var BAD={SCRIPT:1,STYLE:1,IFRAME:1,OBJECT:1,EMBED:1,LINK:1,META:1,FORM:1,BASE:1};
    var els=rootNode.querySelectorAll("*");
    for(var i=els.length-1;i>=0;i--){
      var n=els[i];
      if(BAD[n.tagName]){n.remove();continue;}
      for(var j=n.attributes.length-1;j>=0;j--){
        var a=n.attributes[j],nm=a.name.toLowerCase(),v=String(a.value||"");
        if(nm.indexOf("on")===0){n.removeAttribute(a.name);continue;}
        if((nm==="href"||nm==="src")&&/^\\s*(javascript|vbscript|data):/i.test(v))n.removeAttribute(a.name);
      }
      if(n.tagName==="A"){n.setAttribute("target","_blank");n.setAttribute("rel","noopener noreferrer");}
    }
  }
  function mdRender(text){
    var raw=null;
    try{
      if(window.marked&&marked.parse)raw=marked.parse(text,{breaks:true,async:false});
    }catch(e){raw=null;}
    if(raw==null)return textHtml(text);
    var tpl=document.createElement("template");
    tpl.innerHTML=raw;
    sanitize(tpl.content);
    return tpl.innerHTML;
  }
  function addPreCopy(md){
    var pres=md.querySelectorAll("pre");
    for(var i=0;i<pres.length;i++)(function(pre){
      if(pre.querySelector(".cpb"))return;
      var b=el("button","cpb",tx("複製","Copy"));
      MU.copyBtn(b,function(){var c=pre.querySelector("code");return (c||pre).innerText;});
      pre.appendChild(b);
    })(pres[i]);
  }

  /* ================= 進入點與閘門 ================= */
  function paint(){
    if(streaming)return;   // 串流中不整頁重畫
    if(!me){MU.gateLogin(root,"LLM playground",tx("請先用 Google 登入","Please sign in with Google first."));return;}
    if(!hasSvc()){MU.gatePending(root,me);return;}
    buildApp();
  }
  function start(){
    MU.me(true).then(function(u){
      me=u;
      if(!me||!hasSvc()){paint();return;}
      return Promise.all([api("/api/playground/models"),api("/api/playground/conversations")])
        .then(function(rs){groups=rs[0].rows||[];convs=rs[1].rows||[];paint();});
    }).catch(function(e){root.innerHTML='<div class="gate"><p>'+tx("讀取失敗：","Failed: ")+esc(e.message||e)+'</p></div>';});
  }
  MU.onLang(paint);

  /* ================= 介面骨架 ================= */
  function buildApp(){
    root.innerHTML="";
    var app=el("div","pg");UI.app=app;

    var side=el("aside","pg-side");
    var nw=el("div","pg-new");
    var nb=el("button","pg-newbtn","＋ "+tx("新對話","New chat"));
    nb.addEventListener("click",function(){if(busy())return;newChat();drawer(false);});
    nw.appendChild(nb);side.appendChild(nw);
    UI.clist=el("div","pg-convs");side.appendChild(UI.clist);
    app.appendChild(side);

    var main=el("div","pg-main");
    var top=el("div","pg-top");
    var hb=el("button","pg-histbtn","☰ "+tx("紀錄","History"));
    hb.addEventListener("click",function(){drawer(!app.classList.contains("open"));});
    top.appendChild(hb);
    UI.sel=el("select");UI.sel.title=tx("選擇模型","Choose a model");
    buildModelSel();
    UI.sel.addEventListener("change",function(){try{localStorage.setItem("ipua-pg-model",UI.sel.value);}catch(e){}});
    top.appendChild(UI.sel);
    main.appendChild(top);

    UI.msgs=el("div","pg-msgs");
    UI.msgs.addEventListener("scroll",function(){
      UI.stick=UI.msgs.scrollHeight-UI.msgs.scrollTop-UI.msgs.clientHeight<90;
    });
    UI.stick=true;
    main.appendChild(UI.msgs);

    var comp=el("div","pg-comp");
    UI.ta=el("textarea","pg-ta");
    UI.ta.rows=1;
    UI.ta.placeholder="Ask anything...";
    UI.ta.disabled=!groups.length;
    UI.ta.addEventListener("input",autoGrow);
    UI.ta.addEventListener("keydown",function(e){
      if(e.key==="Enter"&&!e.shiftKey&&!e.isComposing&&!coarse){e.preventDefault();send();}
    });
    comp.appendChild(UI.ta);
    UI.send=el("button","pg-send");
    UI.send.innerHTML=SEND_ICON;
    UI.send.title=tx("送出","Send");
    UI.send.disabled=!groups.length;
    UI.send.addEventListener("click",function(){
      if(streaming){if(aborter)aborter.abort();return;}
      send();
    });
    comp.appendChild(UI.send);
    main.appendChild(comp);
    app.appendChild(main);

    var ovl=el("div","pg-ovl");
    ovl.addEventListener("click",function(){drawer(false);});
    app.appendChild(ovl);

    root.appendChild(app);
    renderConvList();
    renderMsgs();
  }
  function drawer(open){UI.app.classList.toggle("open",!!open);}
  function busy(){if(streaming){MU.flash(tx("回覆生成中 — 先按停止","Still streaming — stop it first"));return true;}return false;}
  // scrollHeight 不含上下邊框（2px）且會取整，直接拿來當 height 永遠差 1~2px，
  // 內容「假性溢出」→ Windows 擠出捲軸箭頭。補上邊框再算，並只在真的超過上限時放出捲軸。
  function autoGrow(){
    UI.ta.style.height="auto";
    var need=UI.ta.scrollHeight+2;
    UI.ta.style.height=Math.min(need,160)+"px";
    UI.ta.style.overflowY=need>160?"auto":"hidden";
  }

  function buildModelSel(){
    UI.sel.innerHTML="";
    if(!groups.length){
      var o=el("option",null,tx("尚無可用模型","No models yet"));o.value="";UI.sel.appendChild(o);UI.sel.disabled=true;return;
    }
    UI.sel.disabled=false;
    var saved="";try{saved=localStorage.getItem("ipua-pg-model")||"";}catch(e){}
    var has=false;
    // 扁平列表：每列「模型名稱 · 渠道」——渠道名本身可能含括號，用間隔號才不會括號套括號
    groups.forEach(function(g){
      g.models.forEach(function(m){
        var o=el("option",null,m+" \\u00b7 "+g.name);o.value=g.slug+"|"+m;
        if(o.value===saved){o.selected=true;has=true;}
        UI.sel.appendChild(o);
      });
    });
    if(!has)UI.sel.selectedIndex=0;
  }
  function pickModel(channel,model){
    var v=channel+"|"+model;
    for(var i=0;i<UI.sel.options.length;i++){
      if(UI.sel.options[i].value===v){UI.sel.value=v;return;}
    }
  }

  /* ================= 對話列表 ================= */
  function ago(iso){
    var t=Date.parse(iso||"");if(isNaN(t))return"";
    var s=(Date.now()-t)/1e3;
    if(s<60)return tx("剛剛","now");
    if(s<3600)return Math.floor(s/60)+tx(" 分鐘前","m");
    if(s<86400)return Math.floor(s/3600)+tx(" 小時前","h");
    if(s<86400*30)return Math.floor(s/86400)+tx(" 天前","d");
    return new Date(t+8*36e5).toISOString().slice(5,10);
  }
  function renderConvList(){
    UI.clist.innerHTML="";
    if(!convs.length){UI.clist.appendChild(el("div","pg-empty",tx("還沒有對話","No conversations yet")));return;}
    convs.forEach(function(c){
      var row=el("div","pg-conv"+(cur===c.id?" on":""));
      var tt=el("div","tt",c.title||tx("（未命名）","(untitled)"));
      tt.title=(c.title||"")+" · "+ago(c.updated_at);
      row.appendChild(tt);
      var rn=el("button","ic","\\u270e");rn.title=tx("改名","Rename");
      rn.addEventListener("click",function(e){e.stopPropagation();renameConv(c);});
      var dl=el("button","ic","\\u2715");dl.title=tx("刪除","Delete");
      dl.addEventListener("click",function(e){e.stopPropagation();deleteConv(c);});
      row.appendChild(rn);row.appendChild(dl);
      row.addEventListener("click",function(){if(busy())return;openConv(c.id);drawer(false);});
      UI.clist.appendChild(row);
    });
  }
  function bumpConv(id){
    for(var i=0;i<convs.length;i++){
      if(convs[i].id===id){
        var c=convs[i];c.updated_at=new Date().toISOString();
        convs.splice(i,1);convs.unshift(c);break;
      }
    }
    renderConvList();
  }
  function renameConv(c){
    var t=prompt(tx("對話名稱","Conversation title"),c.title||"");
    if(t==null)return;
    t=t.replace(/\\s+/g," ").trim();
    if(!t)return;
    api("/api/playground/conversations/"+c.id,{method:"PUT",json:{title:t}})
      .then(function(d){c.title=d.title||t;renderConvList();MU.flash(tx("已改名","Renamed"));})
      .catch(function(e){MU.flash(esc(e.message||e));});
  }
  function deleteConv(c){
    if(!confirm(tx("刪除對話「"+(c.title||"")+"」？此動作無法復原。","Delete this conversation? This cannot be undone.")))return;
    api("/api/playground/conversations/"+c.id,{method:"DELETE"}).then(function(){
      convs=convs.filter(function(x){return x.id!==c.id;});
      if(cur===c.id)newChat();else renderConvList();
      MU.flash(tx("已刪除","Deleted"));
    }).catch(function(e){MU.flash(esc(e.message||e));});
  }
  function openConv(id){
    api("/api/playground/conversations/"+id).then(function(d){
      cur=id;
      msgs=(d.messages||[]).map(function(m){return{role:m.role,content:m.content,model:m.model};});
      if(d.conv&&d.conv.channel&&d.conv.model)pickModel(d.conv.channel,d.conv.model);
      renderConvList();renderMsgs();
    }).catch(function(e){MU.flash(esc(e.message||e));});
  }
  function newChat(){
    cur=null;msgs=[];
    renderConvList();renderMsgs();
    if(!coarse&&UI.ta&&!UI.ta.disabled)UI.ta.focus();
  }

  /* ================= 訊息渲染 ================= */
  function renderMsgs(){
    UI.msgs.innerHTML="";
    if(!msgs.length){var h=hero();if(h)UI.msgs.appendChild(h);return;}
    msgs.forEach(function(m){
      if(m.role==="user")addUserMsg(m.content);
      else addAiMsg(m.model,m.content,true);
    });
    UI.stick=true;scrollBottom(true);
  }
  // 空對話不放任何提示（站長要求乾淨）；只有「完全沒有模型」時提醒一下，不然畫面會像壞掉
  function hero(){
    if(groups.length)return null;
    var h=el("div","pg-hero");
    h.appendChild(el("p",null,tx("站長還沒設定任何模型。","The site owner hasn't configured any models yet.")+(me&&me.is_admin?tx("到「API 中轉站」的管道管理幫渠道加上模型名稱即可。"," Add model names to a channel in the relay admin.") : "")));
    return h;
  }
  function scrollBottom(force){
    if(force||UI.stick)UI.msgs.scrollTop=UI.msgs.scrollHeight;
  }
  function addUserMsg(text){
    var m=el("div","m user");
    m.appendChild(el("div","mb-user",text));
    UI.msgs.appendChild(m);scrollBottom();
    return m;
  }
  function addAiMsg(model,content,final){
    var m=el("div","m ai");
    m.appendChild(el("div","who",model||"AI"));
    var md=el("div","md");
    if(final){md.innerHTML=mdRender(content);addPreCopy(md);}
    else md.innerHTML='<span class="dots"><i></i><i></i><i></i></span>';
    m.appendChild(md);
    if(final&&content)addActions(m,content);
    UI.msgs.appendChild(m);scrollBottom();
    return{box:m,md:md};
  }
  function addActions(box,text){
    var act=el("div","m-act");
    var cp=el("button","mab","\\u29c9 "+tx("複製","Copy"));
    MU.copyBtn(cp,text);
    act.appendChild(cp);box.appendChild(act);
  }
  var rafOn=false,rafNode=null,rafText="";
  function streamPaint(node,text){
    rafNode=node;rafText=text;
    if(rafOn)return;rafOn=true;
    requestAnimationFrame(function(){
      rafOn=false;
      rafNode.md.innerHTML=mdRender(rafText);
      scrollBottom();
    });
  }

  /* ================= 送出與串流 ================= */
  function setStreaming(on){
    streaming=on;
    UI.send.classList.toggle("stop",on);
    UI.send.innerHTML=on?STOP_ICON:SEND_ICON;
    UI.send.title=on?tx("停止","Stop"):tx("送出","Send");
    // 輸入框保持可打字（先打下一句），送出由 streaming 旗標擋住
  }
  function send(){
    if(streaming)return;
    var text=UI.ta.value.replace(/\\s+$/,"");
    if(!text.trim())return;
    var mv=UI.sel.value;
    if(!mv){MU.flash(tx("先選一個模型","Pick a model first"));return;}
    var pi=mv.indexOf("|"),channel=mv.slice(0,pi),model=mv.slice(pi+1);

    if(!msgs.length)UI.msgs.innerHTML="";
    msgs.push({role:"user",content:text});
    addUserMsg(text);
    UI.ta.value="";autoGrow();
    UI.stick=true;

    var node=addAiMsg(model,"",false);
    var got="";
    setStreaming(true);
    aborter=("AbortController" in window)?new AbortController():null;

    var ctx=msgs.slice(-40).map(function(m){return{role:m.role,content:m.content};});
    fetch("/api/playground/chat",{
      method:"POST",
      headers:{"content-type":"application/json"},
      body:JSON.stringify({conv_id:cur,channel:channel,model:model,messages:ctx}),
      signal:aborter?aborter.signal:undefined
    }).then(function(r){
      if(!r.ok){
        return r.json().catch(function(){return{};}).then(function(d){
          if(d.conv&&!cur){cur=d.conv;refreshList();}
          throw new Error(d.hint||d.error||("HTTP "+r.status));
        });
      }
      var reader=r.body.getReader(),dec=new TextDecoder(),buf="";
      function pump(){
        return reader.read().then(function(s){
          if(s.done)return;
          buf+=dec.decode(s.value,{stream:true});
          var i;
          while((i=buf.indexOf("\\n"))>=0){
            var line=buf.slice(0,i).replace(/\\r$/,"");buf=buf.slice(i+1);
            if(line.indexOf("data:")!==0)continue;
            var p=line.slice(5).trim();
            if(!p)continue;
            var j=null;try{j=JSON.parse(p);}catch(e){continue;}
            if(j.conv&&!cur){
              cur=j.conv;
              convs.unshift({id:j.conv,title:j.title||text.slice(0,60),channel:channel,model:model,updated_at:new Date().toISOString()});
              renderConvList();
            }
            if(j.d){got+=j.d;streamPaint(node,got);}
            if(j.error){showErr(node,j.hint||j.error);}
          }
          return pump();
        });
      }
      return pump();
    }).catch(function(e){
      if(!(e&&e.name==="AbortError"))showErr(node,String(e&&e.message||e));
    }).then(function(){
      finishStream(node,got,model);
    });
  }
  function showErr(node,msg){
    var er=el("div","m-err",msg);
    node.box.appendChild(er);
  }
  function finishStream(node,got,model){
    setStreaming(false);aborter=null;
    if(got){
      msgs.push({role:"assistant",content:got,model:model});
      node.md.innerHTML=mdRender(got);
      addPreCopy(node.md);
      addActions(node.box,got);
    }else{
      var d=node.md.querySelector(".dots");if(d)d.remove();
    }
    if(cur)bumpConv(cur);
    scrollBottom();
    if(!coarse)UI.ta.focus();
  }
  function refreshList(){
    api("/api/playground/conversations").then(function(d){convs=d.rows||[];renderConvList();}).catch(function(){});
  }

  start();
})();
`;
