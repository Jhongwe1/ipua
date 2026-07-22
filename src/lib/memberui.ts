// src/lib/memberui.ts — 會員頁（/relay、/vpn、/members）共用的樣式與前端小工具。
// 這些頁面都用同一套外殼（pageShell），差別只在內容；共用的部分抽在這裡：
//   MEMBER_CSS  卡片、狀態徽章、程式碼框、複製鈕、開關列等元件樣式
//   MEMBER_JS   前端 helper：ipuaMe()（抓 /api/me）、$、copyBtn()、badge()、statusText()

export const MEMBER_CSS = `
  .wrap{max-width:820px}
  .acct{display:flex;align-items:center;gap:14px;border:1px solid var(--line);border-radius:14px;padding:14px 16px;margin-bottom:18px;background:var(--card)}
  .acct img{width:44px;height:44px;border-radius:50%;object-fit:cover;background:var(--field);flex:0 0 auto}
  .acct .who{flex:1;min-width:0}
  .acct .nm{font-weight:700;font-size:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .acct .em{font-size:12.5px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .badge{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:700;letter-spacing:.04em;border-radius:20px;padding:3px 11px;border:1px solid var(--line);color:var(--muted);white-space:nowrap}
  .badge.ok{background:var(--accent);color:var(--accent-fg);border-color:var(--line2)}
  .badge.warn{border-color:var(--line2);color:var(--fg)}
  .badge.bad{border-color:#c33;color:#c33}
  .lead{font-size:14.5px;line-height:1.75;color:var(--muted);margin:0 0 18px}
  .kbox{display:flex;gap:8px;align-items:stretch;flex-wrap:wrap}
  .kbox .code{flex:1;min-width:220px}
  .code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;background:var(--field);border:1px solid var(--line);border-radius:8px;padding:11px 12px;overflow-x:auto;white-space:nowrap;display:flex;align-items:center}
  pre.code{white-space:pre;line-height:1.7;display:block}
  .copy2{border:1px solid var(--line2);background:var(--accent);color:var(--accent-fg);border-radius:8px;padding:0 16px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit;white-space:nowrap;display:inline-flex;align-items:center;gap:6px}
  .copy2.ghosty{background:transparent;color:var(--fg);border-color:var(--line)}
  .copy2:active{transform:translateY(1px)}
  .rowline{display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:1px dashed var(--line)}
  .rowline:last-child{border-bottom:0}
  .rowline .g{flex:1;min-width:0}
  .rowline .t1{font-weight:600;font-size:14px}
  .rowline .t2{font-size:12px;color:var(--muted);margin-top:2px;overflow-wrap:anywhere}
  .gate{text-align:center;padding:40px 16px}
  .gate h2{font-size:19px;margin:0 0 8px}
  .gate p{font-size:14px;color:var(--muted);line-height:1.7;max-width:440px;margin:0 auto 18px}
  .gbtn{display:inline-flex;align-items:center;gap:8px;background:var(--accent);color:var(--accent-fg);border:1px solid var(--line2);border-radius:9px;padding:12px 22px;font-size:14.5px;font-weight:700;text-decoration:none;cursor:pointer;font-family:inherit}
  .gcontact{display:inline-flex;align-items:center;border:1px solid var(--line);border-radius:16px;padding:6px 14px;font-size:12px;font-weight:600;color:var(--muted);text-decoration:none;margin-top:16px;transition:.15s}
  .gcontact:hover{border-color:var(--line2);color:var(--fg)}
  .muted{color:var(--muted);font-size:12.5px}
  .spin{display:inline-block;width:18px;height:18px;border:2px solid var(--line);border-top-color:var(--fg);border-radius:50%;animation:sp .7s linear infinite;vertical-align:-3px}
  @keyframes sp{to{transform:rotate(360deg)}}
  .flash{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:var(--accent);color:var(--accent-fg);padding:10px 18px;border-radius:24px;font-size:13px;font-weight:600;box-shadow:0 8px 28px rgba(0,0,0,.24);opacity:0;transition:opacity .2s,transform .2s;pointer-events:none;z-index:200}
  .flash.show{opacity:1;transform:translateX(-50%) translateY(-4px)}
`;

// 前端 helper（IIFE 掛在 window.MU）。頁面腳本先 await MU.me() 拿身分再畫內容。
export const MEMBER_JS = `
(function(){
  "use strict";
  var origin=location.origin;
  function $(id){return document.getElementById(id);}
  function el(t,c,x){var n=document.createElement(t);if(c)n.className=c;if(x!=null)n.textContent=x;return n;}
  function esc(s){return String(s==null?"":s).replace(/[&<>"']/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];});}
  // 每次都讀最新語言（右上角切換後不必重載頁面）；v2.2 起預設英文
  function curLang(){try{return localStorage.getItem("ipua-lang")==="zh"?"zh":"en";}catch(e){return "en";}}
  function tx(zh,en){return curLang()==="en"?en:zh;}
  // 頁面可註冊：切語言時重新渲染
  function onLang(fn){try{window.addEventListener("ipua:lang",fn);}catch(e){}}
  var meCache=null;
  function me(force){
    if(meCache&&!force)return Promise.resolve(meCache);
    return fetch("/api/me",{cache:"no-store"}).then(function(r){return r.json();}).then(function(d){meCache=d.user;return d.user;});
  }
  function statusText(s){
    return s==="approved"?tx("已核准","Approved"):s==="pending"?tx("待核准","Pending"):s==="blocked"?tx("已封鎖","Blocked"):s;
  }
  function badge(user){
    var cls=user.status==="approved"?"ok":user.status==="blocked"?"bad":"warn";
    var b=el("span","badge "+cls,statusText(user.status));
    if(user.is_admin){var a=el("span","badge ok",tx("管理員","Admin"));return[a,b];}
    return[b];
  }
  // 帳號卡：頭像＋名字＋信箱＋狀態徽章。host 是要塞進去的容器元素。
  function acctCard(user){
    var box=el("div","acct");
    var img=el("img");img.alt="";img.referrerPolicy="no-referrer";
    img.src=user.picture||("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 40'%3E%3Crect width='40' height='40' fill='%23ccc'/%3E%3C/svg%3E");
    box.appendChild(img);
    var who=el("div","who");
    who.appendChild(el("div","nm",user.name||user.email));
    who.appendChild(el("div","em",user.email));
    box.appendChild(who);
    var bw=el("div");bw.style.cssText="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end";
    badge(user).forEach(function(b){bw.appendChild(b);});
    box.appendChild(bw);
    return box;
  }
  // 管理員的聯絡方式（閘門畫面的「聯絡我」小鈕）：連結存 settings 表 contact_url 鍵，
  // 由公開的 /api/settings 讀回。沒設定＝不顯示 — 按鈕先隱藏，拿到網址才現身。
  var setCache=null;
  function siteSettings(){
    if(setCache)return Promise.resolve(setCache);
    return fetch("/api/settings",{cache:"no-store"}).then(function(r){return r.json();})
      .then(function(d){setCache=d||{};return setCache;});
  }
  // url：呼叫端已經知道網址時直接給（例額度 429 回的 contact_url）— 省掉一次 /api/settings。
  function contactBtn(url){
    var a=el("a","gcontact",tx("聯絡管理員","Contact Admin"));
    a.target="_blank";a.rel="noopener noreferrer";a.style.display="none";
    if(url){a.href=url;a.style.display="";return a;}
    siteSettings().then(function(s){
      if(s&&s.contact_url){a.href=s.contact_url;a.style.display="";}
    }).catch(function(){});
    return a;
  }
  // 登入閘門畫面（未登入時）
  function gateLogin(host,title,desc){
    host.innerHTML="";
    var g=el("div","gate");
    g.appendChild(el("h2",null,title));
    g.appendChild(el("p",null,desc));
    var a=el("a","gbtn",tx("使用 Google 登入","Sign in with Google"));
    a.href="/auth/login?next="+encodeURIComponent(location.pathname);
    g.appendChild(a);
    g.appendChild(el("br"));
    g.appendChild(contactBtn());
    host.appendChild(g);
  }
  // 待批准畫面
  function gatePending(host,user){
    host.innerHTML="";
    host.appendChild(acctCard(user));
    var g=el("div","gate");
    g.appendChild(el("h2",null,tx("等待管理員批准","Waiting for approval")));
    g.appendChild(el("p",null,tx("你已經用 "+user.email+" 登入了，但這個服務需要管理員批准後才能使用。批准後回來重新整理即可。","You're signed in as "+user.email+", but this service needs the site owner's approval first.")));
    g.appendChild(contactBtn());
    host.appendChild(g);
  }
  function flash(msg){
    var f=$("mu-flash");
    if(!f){f=el("div","flash");f.id="mu-flash";document.body.appendChild(f);}
    f.textContent=msg;f.classList.add("show");
    clearTimeout(f._t);f._t=setTimeout(function(){f.classList.remove("show");},1600);
  }
  function copy(text){
    if(navigator.clipboard&&navigator.clipboard.writeText)return navigator.clipboard.writeText(text);
    return new Promise(function(res,rej){
      var ta=document.createElement("textarea");ta.value=text;ta.style.cssText="position:fixed;opacity:0";
      document.body.appendChild(ta);ta.select();try{document.execCommand("copy");res();}catch(e){rej(e);}ta.remove();
    });
  }
  // 綁一顆複製鈕：按下複製 textOrFn（可為函式）並閃一下提示
  function copyBtn(btn,textOrFn){
    btn.addEventListener("click",function(){
      var t=typeof textOrFn==="function"?textOrFn():textOrFn;
      if(!t)return;
      copy(t).then(function(){flash(tx("已複製","Copied"));}).catch(function(){flash(tx("複製失敗","Copy failed"));});
    });
  }
  window.MU={$:$,el:el,esc:esc,tx:tx,onLang:onLang,me:me,statusText:statusText,badge:badge,acctCard:acctCard,
             gateLogin:gateLogin,gatePending:gatePending,flash:flash,copy:copy,copyBtn:copyBtn,origin:origin,
             contactBtn:contactBtn};
})();
`;
