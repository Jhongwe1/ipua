// GET /playground — Playground（會員頁；v2.2 起是「聊天主頁」，外觀仿 chatgpt.com）。
// 未登入 → 登入閘門；沒被批准 playground 服務 → 等待批准畫面；批准後是完整聊天介面：
// 頂部「Chat ∨」＝模型選單（管理員在 /relay 渠道裡設定的清單）、右上「⋯」＝刪除目前對話、
// 串流回覆、Markdown 渲染（含程式碼複製）、空對話置中歡迎語＋輸入框。
// 歷史對話列表（History）由外殼側邊欄負責（src/lib/site.ts 的 SHELL_JS），這裡透過
// window.__pgOpenConv / __pgNewChat / __pgConvDeleted 與 window.SBH 橋接。
// 後端邏輯在 src/lib/playground.ts 與 src/routes/api/playground/*。
import { html, pageShell, assetSrc } from "./site.js";
import { getChromeFor } from "./chrome.js";
import { MEMBER_CSS, MEMBER_JS } from "./memberui.js";
import type { Env } from "../types.js";

const PG_CSS = `
  /* 聊天鋪滿內容區：外殼 .content 的留白歸零、頁尾藏起來 */
  .content{padding:0}
  .wrap{max-width:none;margin:0;height:100%;display:flex;flex-direction:column;min-height:0}
  footer{display:none}
  #root{flex:1;min-height:0;display:flex;flex-direction:column}
  /* 頂部「Chat ∨」模型選單鈕（放在外殼 h1 裡） */
  .pg-title{border:0;background:none;color:var(--fg);font-family:inherit;font-size:16px;font-weight:600;
            display:inline-flex;align-items:center;gap:5px;padding:6px 10px;border-radius:9px;cursor:pointer;min-width:0}
  .pg-title:hover{background:var(--hov)}
  .pg-title .cv{color:var(--muted);font-size:11px}
  .pg-title .mn{color:var(--muted);font-weight:500;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:180px}
  @media(max-width:560px){.pg-title .mn{display:none}}
  /* 今日用量小字（頁首右側） */
  .pg-usage{font-size:11.5px;color:var(--sub);white-space:nowrap;margin-right:2px}
  /* ---- 聊天主體 ---- */
  .pg{flex:1;min-height:0;display:flex;flex-direction:column}
  .pg-msgs{flex:1;min-height:0;overflow-y:auto;padding:18px 16px 8px;display:flex;flex-direction:column;gap:16px}
  .pg-msgs::-webkit-scrollbar{width:8px}
  .pg-msgs::-webkit-scrollbar-track{background:transparent}
  .pg-msgs::-webkit-scrollbar-thumb{background:var(--line);border-radius:4px;border:2px solid transparent;background-clip:content-box}
  .m{width:100%;max-width:760px;margin:0 auto;flex:0 0 auto}
  .m.user{display:flex;justify-content:flex-end}
  /* 使用者訊息：ChatGPT 式灰底氣泡（不再用反色） */
  .mb-user{background:var(--field);color:var(--fg);border-radius:18px;padding:10px 16px;max-width:84%;
           font-size:15px;line-height:1.7;white-space:pre-wrap;overflow-wrap:anywhere}
  .m.ai .md{font-size:15px;line-height:1.85;overflow-wrap:anywhere;min-width:0}
  .m-act{margin-top:6px}
  .mab{border:0;background:none;color:var(--muted);border-radius:7px;padding:4px 9px;
       font-size:11.5px;font-weight:600;cursor:pointer;font-family:inherit;transition:.15s}
  .mab:hover{background:var(--hov);color:var(--fg)}
  .m-err{color:#e02e2a;font-size:13px;border:1px solid rgba(224,46,42,.5);border-radius:10px;padding:8px 12px;margin-top:8px}
  /* 額度用完時附在錯誤框裡的「聯絡我」鈕：自己一行 */
  .m-err .gcontact{display:flex;width:fit-content;margin-top:8px}
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
  .dots-w{display:inline-flex;gap:4px;padding:8px 0}
  .dots-w i{width:6px;height:6px;border-radius:50%;background:var(--muted);animation:pgb 1s infinite}
  .dots-w i:nth-child(2){animation-delay:.15s}
  .dots-w i:nth-child(3){animation-delay:.3s}
  @keyframes pgb{0%,60%,100%{opacity:.25;transform:none}30%{opacity:1;transform:translateY(-3px)}}
  /* 推理模型的思考過程：串流中自動展開（畫面才不會空白），正文一開始吐就自動收合 */
  .think{border:1px solid var(--line);border-radius:10px;margin:0 0 9px;background:var(--field);overflow:hidden}
  .think>summary{cursor:pointer;list-style:none;padding:7px 11px;font-size:11.5px;color:var(--muted);
    letter-spacing:.03em;user-select:none;display:flex;align-items:center;gap:6px}
  .think>summary::-webkit-details-marker{display:none}
  .think>summary::before{content:"▸";font-size:9px;transition:transform .15s;flex:0 0 auto}
  .think[open]>summary::before{transform:rotate(90deg)}
  .think>summary:hover{color:var(--fg)}
  .think-body{padding:0 11px 9px;font-size:12.5px;line-height:1.75;color:var(--muted);
    white-space:pre-wrap;overflow-wrap:anywhere;max-height:220px;overflow-y:auto}
  /* 空狀態：置中歡迎語（ChatGPT「How can I help?」），輸入框跟著置中 */
  .pg-hero{text-align:center;padding:0 16px 4px;max-width:640px;margin:0 auto;width:100%}
  .pg-hero h2{font-size:26px;font-weight:600;letter-spacing:0}
  .pg-hero p{font-size:13.5px;color:var(--muted);line-height:1.75;margin:10px 0 0}
  .pg.empty{justify-content:center;gap:22px}
  .pg.empty .pg-msgs{display:none}
  .pg:not(.empty) .pg-hero{display:none}
  /* ---- 輸入區（膠囊）---- */
  .pg-comp-w{flex:0 0 auto;padding:8px 16px 18px;width:100%}
  .pg.empty .pg-comp-w{flex:0 0 auto;padding-top:0}
  .pg-comp{display:flex;align-items:flex-end;gap:4px;max-width:760px;margin:0 auto;
           background:var(--field);border:1px solid var(--line);border-radius:26px;padding:7px 8px}
  [data-theme="dark"] .pg-comp{border-color:transparent}
  .pg-plus{width:36px;height:36px;flex:0 0 auto;border:0;background:none;color:var(--fg);border-radius:50%;
           font-size:18px;line-height:1;cursor:pointer;font-family:inherit;display:inline-flex;align-items:center;justify-content:center;transition:.15s}
  .pg-plus:hover{background:var(--hov)}
  /* overflow-y 平常藏起來，長文超過 max-height 時才由 autoGrow 放出捲軸 */
  .pg-ta{flex:1;resize:none;border:0;background:none;color:var(--fg);
         padding:8px 6px;font-size:15px;font-family:inherit;line-height:1.55;outline:none;
         min-height:36px;max-height:200px;box-sizing:border-box;overflow-y:hidden}
  .pg-ta::placeholder{color:var(--sub)}
  .pg-send{width:36px;height:36px;flex:0 0 auto;border-radius:50%;border:0;background:var(--accent);
           color:var(--accent-fg);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;font-family:inherit;transition:.15s}
  .pg-send svg{display:block}
  .pg-send:not(:disabled):active{transform:translateY(1px)}
  .pg-send:disabled{opacity:.3;cursor:default}
  .pg-send.stop{background:var(--fg);color:var(--bg)}
  @media(max-width:560px){
    .pg-comp-w{padding:6px 10px 12px}
    .pg-hero h2{font-size:22px}
  }
  /* 觸控裝置：輸入框字級 <16px 時 iOS Safari 聚焦會自動放大整頁 — 拉到 16px 就不會 */
  @media(hover:none){
    .pg-ta{font-size:16px}
  }
  /* 體驗模式橫幅（Phase K）：未登入＋demo 開時顯示在聊天區頂端 */
  .pg-demo{flex:0 0 auto;max-width:760px;width:calc(100% - 32px);margin:10px auto 0;border:1px solid var(--line);
           background:var(--card);border-radius:12px;padding:9px 14px;font-size:13px;color:var(--muted);line-height:1.7}
  .pg-demo b{color:var(--fg)}
  .pg-demo a{color:var(--fg);font-weight:700;white-space:nowrap}
  .pg.empty .pg-demo{margin:0 auto}
`;

export async function playgroundPageResponse(env: Env, request: Request): Promise<Response> {
  const { chrome } = await getChromeFor(env, request); // 選單依身分過濾（VPN 隱形）
  const body =
    '<div id="root"><div class="gate"><div class="spin"></div></div></div>\n' +
    '<script data-nonce src="' +
    assetSrc("marked.js") +
    '"></script>\n' +
    "<script data-nonce>" +
    MEMBER_JS +
    "</script>\n" +
    "<script data-nonce>" +
    PG_JS +
    "</script>";
  return html(
    pageShell({
      title: "Chat",
      tkey: "page.playground",
      desc: "會員專用的 Playground — 在網頁上直接試用站上的 AI 模型。",
      noindex: true,
      chrome: chrome,
      activePath: "/playground",
      // 頁首標題＝模型選單鈕（PG_JS 接手；模型清單載入前先顯示純「Chat」）
      h1: '<button id="pgTitle" class="pg-title" type="button">Chat <span class="cv">▼</span></button>',
      // 蓋掉外殼的 viewport（後出現者生效）：鎖 maximum-scale，手機點輸入框不會自動放大頁面
      headExtra:
        '<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">\n' +
        "<style>" +
        MEMBER_CSS +
        PG_CSS +
        "</style>\n",
      body: body
    })
  );
}

const PG_JS = `
(function(){
  "use strict";
  var $=MU.$,el=MU.el,tx=MU.tx,esc=MU.esc;
  var root=$("root");
  // 送出／停止圖示（SVG 線條箭頭與圓角方塊）
  var SEND_ICON='<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';
  var STOP_ICON='<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="3"/></svg>';
  var me=null,groups=[],cur=null,msgs=[];
  var demoMode=false;  // 體驗模式（未登入＋管理員開 demo）：無歷史（對話只有管理員看得到）
  var streaming=false,aborter=null;
  var UI={};
  var model="";        // 目前選的模型（"channelSlug|modelName"）
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
    if(!me){MU.gateLogin(root,"Playground",tx("請先用 Google 登入","Please sign in with Google first."));return;}
    if(!hasSvc()){MU.gatePending(root,me);return;}
    buildApp();
  }
  function start(){
    MU.me(true).then(function(u){
      me=u;
      if(!me){
        /* 未登入：demo 開著就直接進體驗模式聊天，關著照舊顯示登入閘門 */
        return api("/api/settings").then(function(s){
          if(!s.demo){paint();return;}
          demoMode=true;
          return api("/api/playground/models").then(function(r){groups=r.rows||[];buildApp();});
        });
      }
      if(!hasSvc()){paint();return;}
      return api("/api/playground/models").then(function(r){
        groups=r.rows||[];
        paint();
        /* 側欄 History 由外殼載入；#c=<id> 進來（他頁點歷史）就直接打開那筆 */
        var m=location.hash.match(/^#c=(.+)$/);
        if(m)openConv(decodeURIComponent(m[1]));
      });
    }).catch(function(e){root.innerHTML='<div class="gate"><p>'+tx("讀取失敗：","Failed: ")+esc(e.message||e)+'</p></div>';});
  }
  MU.onLang(function(){paint();updateTitle();updateMore();});

  /* ================= 頂部：模型選單（Chat ∨）與「⋯」刪除 ================= */
  function savedModel(){var s="";try{s=localStorage.getItem("ipua-pg-model")||"";}catch(e){}return s;}
  function allModels(){
    var out=[];
    groups.forEach(function(g){(g.models||[]).forEach(function(m){out.push({v:g.slug+"|"+m,name:m,ch:g.name});});});
    return out;
  }
  function ensureModel(){
    var list=allModels();
    if(!list.length){model="";return;}
    var s=savedModel();
    model=list.some(function(x){return x.v===s;})?s:list[0].v;
  }
  function modelName(){
    var pi=model.indexOf("|");
    return pi<0?"":model.slice(pi+1);
  }
  function updateTitle(){
    var b=document.getElementById("pgTitle");
    if(!b)return;
    b.innerHTML="Chat "+(modelName()?'<span class="mn">'+esc(modelName())+"</span> ":"")+'<span class="cv">\\u25bc</span>';
    b.title=tx("選擇模型","Choose a model");
  }
  function modelMenu(){
    var b=document.getElementById("pgTitle");
    if(!b||!window.SBPOP)return;
    var list=allModels();
    window.SBPOP.open(b,function(p){
      if(!list.length){
        var d=el("div","phead",tx("尚無可用模型","No models yet"));p.appendChild(d);return;
      }
      list.forEach(function(x){
        var it=window.SBPOP.item(p,"",function(){
          model=x.v;
          try{localStorage.setItem("ipua-pg-model",model);}catch(e){}
          updateTitle();
        });
        it.textContent=x.name+" \\u00b7 "+x.ch;
        if(x.v===model){
          var k=el("span","pk","\\u2713");
          it.appendChild(k);
        }
      });
    });
  }
  function mountTop(){
    var b=document.getElementById("pgTitle");
    if(b&&!b.getAttribute("data-pg")){
      b.setAttribute("data-pg","1");
      b.addEventListener("click",function(e){e.stopPropagation();modelMenu();});
    }
    updateTitle();
    var c=document.querySelector("header .ctrls");
    if(c&&!document.getElementById("pgMore")&&!demoMode){
      /* 今日用量（/api/me 的 usage 區塊；管理員無上限顯示 ∞） */
      if(me&&me.usage&&me.usage.pg_today!=null){
        var uq=el("span","pg-usage");
        uq.id="pgUsage";
        uq.textContent=me.usage.pg_today+" / "+(me.usage.pg_limit==null?"\\u221e":me.usage.pg_limit);
        uq.title=tx("今日已用訊息數／每日上限（UTC 午夜重置）","Messages today / daily limit (resets at UTC midnight)");
        c.insertBefore(uq,c.firstChild);
      }
      var mb=el("button","ctrl");
      mb.id="pgMore";mb.type="button";mb.textContent="\\u22ef";
      mb.style.display="none";
      mb.addEventListener("click",function(e){
        e.stopPropagation();
        window.SBPOP.open(mb,function(p){
          window.SBPOP.item(p,tx("刪除","Delete"),function(){deleteCur();},true);
        });
      });
      c.insertBefore(mb,c.firstChild);
    }
    updateMore();
  }
  function updateMore(){
    var mb=document.getElementById("pgMore");
    if(mb){mb.style.display=cur?"":"none";mb.title=tx("對話選項","Conversation options");}
  }
  function deleteCur(){
    if(!cur)return;
    if(!confirm(tx("刪除這則對話？此動作無法復原。","Delete this conversation? This cannot be undone.")))return;
    api("/api/playground/conversations/"+cur,{method:"DELETE"}).then(function(){
      newChat();
      if(window.SBH)window.SBH.refresh();
      MU.flash(tx("已刪除","Deleted"));
    }).catch(function(e){MU.flash(esc(e.message||e));});
  }

  /* ================= 介面骨架 ================= */
  function buildApp(){
    root.innerHTML="";
    ensureModel();
    var app=el("div","pg");UI.app=app;

    if(demoMode){
      /* 體驗模式橫幅＋登入 CTA（限制細節不寫這裡 — 真的撞到限流時錯誤訊息才會講） */
      var bn=el("div","pg-demo");
      bn.innerHTML="<b>"+tx("體驗模式","Demo mode")+"</b> · "
        +'<a href="/auth/login?next=/playground">'+tx("登入解鎖完整功能 →","Sign in for full access →")+"</a>";
      app.appendChild(bn);
    }

    UI.msgs=el("div","pg-msgs");
    UI.msgs.addEventListener("scroll",function(){
      UI.stick=UI.msgs.scrollHeight-UI.msgs.scrollTop-UI.msgs.clientHeight<90;
    });
    UI.stick=true;
    app.appendChild(UI.msgs);

    /* 空狀態歡迎語（ChatGPT「How can I help?」） */
    UI.hero=el("div","pg-hero");
    var hh=el("h2",null,tx("有什麼我能幫上的？","How can I help?"));
    UI.hero.appendChild(hh);
    if(!groups.length){
      UI.hero.appendChild(el("p",null,
        demoMode?tx("體驗模式暫時沒有可用的模型，請稍後再來或登入。","Demo mode has no models available right now.")
        :tx("管理員還沒設定任何模型。","The site owner hasn't configured any models yet.")+(me&&me.is_admin?tx("到「API 中轉站」的管道管理幫渠道加上模型名稱即可。"," Add model names to a channel in the relay admin.") : "")));
    }
    app.appendChild(UI.hero);

    var compW=el("div","pg-comp-w");
    var comp=el("div","pg-comp");
    var plus=el("button","pg-plus");
    plus.type="button";plus.textContent="\\uff0b";
    plus.title=tx("附加","Attach");
    plus.addEventListener("click",function(){MU.flash(tx("功能未開放","Feature not available"));});
    comp.appendChild(plus);
    UI.ta=el("textarea","pg-ta");
    UI.ta.rows=1;
    UI.ta.placeholder=tx("詢問任何問題","Ask anything");
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
    compW.appendChild(comp);
    app.appendChild(compW);

    root.appendChild(app);
    mountTop();
    renderMsgs();
  }
  function busy(){if(streaming){MU.flash(tx("回覆生成中 — 先按停止","Still streaming — stop it first"));return true;}return false;}
  function setEmpty(){
    if(UI.app)UI.app.classList.toggle("empty",!msgs.length);
  }
  // scrollHeight 不含上下邊框且會取整，直接拿來當 height 會差 1~2px（假性溢出 → Windows 擠出捲軸箭頭）。
  function autoGrow(){
    UI.ta.style.height="auto";
    var need=UI.ta.scrollHeight+2;
    UI.ta.style.height=Math.min(need,200)+"px";
    UI.ta.style.overflowY=need>200?"auto":"hidden";
  }

  /* ================= 對話切換（側欄 History 呼叫） ================= */
  function openConv(id){
    if(busy())return;
    api("/api/playground/conversations/"+id).then(function(d){
      cur=id;
      msgs=(d.messages||[]).map(function(m){return{role:m.role,content:m.content,model:m.model};});
      if(d.conv&&d.conv.channel&&d.conv.model){
        var v=d.conv.channel+"|"+d.conv.model;
        if(allModels().some(function(x){return x.v===v;})){model=v;updateTitle();}
      }
      if(window.SBH)window.SBH.setActive(id);
      renderMsgs();updateMore();
    }).catch(function(e){MU.flash(esc(e.message||e));});
  }
  function newChat(){
    cur=null;msgs=[];
    if(window.SBH)window.SBH.setActive(null);
    renderMsgs();updateMore();
    if(!coarse&&UI.ta&&!UI.ta.disabled)UI.ta.focus();
  }
  /* 外殼側欄的橋接點 */
  window.__pgOpenConv=openConv;
  window.__pgNewChat=function(){if(!busy())newChat();};
  window.__pgConvDeleted=function(id){if(cur===id)newChat();};

  /* ================= 訊息渲染 ================= */
  function renderMsgs(){
    UI.msgs.innerHTML="";
    setEmpty();
    if(!msgs.length)return;
    msgs.forEach(function(m){
      if(m.role==="user")addUserMsg(m.content);
      else addAiMsg(m.content,true);
    });
    UI.stick=true;scrollBottom(true);
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
  function addAiMsg(content,final){
    var m=el("div","m ai");
    var md=el("div","md");
    if(final){md.innerHTML=mdRender(content);addPreCopy(md);}
    else md.innerHTML='<span class="dots-w"><i></i><i></i><i></i></span>';
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
  /* ---- 思考過程（推理模型的 reasoning_content）---- */
  // 第一筆思考增量到才建區塊 — 非推理模型完全不會看到這個東西
  function ensureThink(node){
    if(node.think)return node.think;
    var d=el("details","think");d.open=true;
    var s=el("summary",null,tx("思考中…","Thinking…"));
    var b=el("div","think-body");
    d.appendChild(s);d.appendChild(b);
    node.box.insertBefore(d,node.md);
    node.think={box:d,sum:s,body:b,t0:Date.now(),text:"",done:false};
    return node.think;
  }
  function thinkSecs(t){return Math.round((Date.now()-t.t0)/1000);}
  var trafOn=false,trafT=null;
  function thinkPaint(t){
    trafT=t;
    if(trafOn)return;trafOn=true;
    requestAnimationFrame(function(){
      trafOn=false;
      // textContent — 思考內容一律當純文字，不進 markdown、不會被當 HTML 解析
      trafT.body.textContent=trafT.text;
      trafT.sum.textContent=tx("思考中… ","Thinking… ")+thinkSecs(trafT)+"s";
      trafT.body.scrollTop=trafT.body.scrollHeight;
      scrollBottom();
    });
  }
  // 思考結束（正文開始吐、或整串結束）→ 收合並把標題改成最終秒數
  function thinkDone(node){
    var t=node&&node.think;
    if(!t||t.done)return;
    t.done=true;t.box.open=false;
    t.sum.textContent=tx("已思考 ","Thought for ")+thinkSecs(t)+"s";
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
    if(!model){MU.flash(tx("先選一個模型","Pick a model first"));return;}
    var pi=model.indexOf("|"),channel=model.slice(0,pi),mname=model.slice(pi+1);

    msgs.push({role:"user",content:text});
    setEmpty();
    addUserMsg(text);
    UI.ta.value="";autoGrow();
    UI.stick=true;

    var node=addAiMsg("",false);
    var got="";
    setStreaming(true);
    aborter=("AbortController" in window)?new AbortController():null;

    var ctx=msgs.slice(-40).map(function(m){return{role:m.role,content:m.content};});
    fetch("/api/playground/chat",{
      method:"POST",
      headers:{"content-type":"application/json"},
      body:JSON.stringify({conv_id:cur,channel:channel,model:mname,messages:ctx}),
      signal:aborter?aborter.signal:undefined
    }).then(function(r){
      if(!r.ok){
        return r.json().catch(function(){return{};}).then(function(d){
          if(d.conv&&!cur){cur=d.conv;afterConvCreated();}
          // 額度 429 會附 contact_url — 掛在 Error 上帶到 catch，那裡才有 node 可以畫
          var er=new Error(d.hint||d.error||("HTTP "+r.status));
          er.contactUrl=d.contact_url||"";
          throw er;
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
            if(j.conv&&!cur){cur=j.conv;afterConvCreated();}
            if(j.r){var th=ensureThink(node);th.text+=j.r;thinkPaint(th);}
            // 正文第一個字＝思考階段結束（沒思考過的話這是 no-op）
            if(j.d){thinkDone(node);got+=j.d;streamPaint(node,got);}
            if(j.error){thinkDone(node);showErr(node,j.hint||j.error,j.contact_url);}
          }
          return pump();
        });
      }
      return pump();
    }).catch(function(e){
      if(!(e&&e.name==="AbortError"))showErr(node,String(e&&e.message||e),e&&e.contactUrl);
    }).then(function(){
      finishStream(node,got);
    });
  }
  /* 新對話在伺服器端建立完成：更新側欄 History＋右上「⋯」（體驗模式沒有側欄歷史） */
  function afterConvCreated(){
    updateMore();
    if(!demoMode&&window.SBH){window.SBH.refresh();window.SBH.setActive(cur);}
  }
  // 額度用完之類的錯誤，伺服器會附 contact_url — 直接放一顆跟登入閘門同款的「聯絡我」鈕，
  // 比丟一長串網址叫人自己複製好按。
  //
  // ⚠ 這整段是「樣板字串裡的 JS」：反斜線會先被樣板字串吃掉一層，正則要寫成 \\s、\\/ 才對。
  // 少跳一次的話這包腳本會整個解析失敗 → /playground 永遠停在轉圈圈，而且 console 之外
  // 完全看不出來（頁面沒有任何錯誤畫面）。2026-07-21 實際踩過一次。
  // 所以這裡刻意只用字串操作，連正則都不碰。
  function showErr(node,msg,contact){
    var s=String(msg==null?"":msg);
    // hint 尾端那份網址是給 /relay 的 API 使用者看的（他們沒有前端可以渲染按鈕）；
    // 網頁這邊已經有按鈕了，把它切掉免得同一條網址在同一格出現兩次。
    if(contact){
      var tail="："+contact;
      if(s.length>tail.length&&s.slice(-tail.length)===tail)s=s.slice(0,s.length-tail.length);
    }
    var er=el("div","m-err",s);
    if(contact)er.appendChild(MU.contactBtn(contact));
    node.box.appendChild(er);
  }
  function finishStream(node,got){
    setStreaming(false);aborter=null;
    thinkDone(node); // 只思考沒正文時，這裡才會是結束思考的時機
    if(got){
      msgs.push({role:"assistant",content:got,model:modelName()});
      node.md.innerHTML=mdRender(got);
      addPreCopy(node.md);
      addActions(node.box,got);
    }else{
      var d=node.md.querySelector(".dots-w");if(d)d.remove();
    }
    if(cur&&!demoMode&&window.SBH)window.SBH.refresh();
    scrollBottom();
    if(!coarse)UI.ta.focus();
  }

  start();
})();
`;
