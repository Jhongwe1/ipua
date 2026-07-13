// GET /members — 成員管理（站長專用頁）。
// 非站長（未登入／一般會員）→ 顯示「僅限站長」擋板。站長 → 列出所有帳號，
// 可核准／封鎖／解封／升降管理員／刪除。所有動作打 /api/admin/users。
import { html, pageShell, getChrome } from "../lib/site.js";
import { MEMBER_CSS, MEMBER_JS } from "../lib/memberui.js";

const PAGE_CSS = `
  .wrap{max-width:920px}
  .card{border:1px solid var(--line);border-radius:13px;padding:0;margin-bottom:16px;background:var(--card);overflow:hidden}
  .u{display:flex;align-items:center;gap:13px;padding:14px 16px;border-bottom:1px solid var(--line)}
  .u:last-child{border-bottom:0}
  .u img{width:40px;height:40px;border-radius:50%;object-fit:cover;background:var(--field);flex:0 0 auto}
  .u .info{flex:1;min-width:0}
  .u .nm{font-weight:700;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .u .em{font-size:12px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .u .st{font-size:11.5px;color:var(--sub);margin-top:2px}
  .u .acts{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;flex:0 0 auto}
  .mbtn{border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:7px;padding:6px 11px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;white-space:nowrap;transition:.15s}
  .mbtn:hover{border-color:var(--line2)}
  .mbtn.pri{background:var(--accent);color:var(--accent-fg);border-color:var(--line2)}
  .mbtn.danger:hover{border-color:#c33;color:#c33}
  .filters{display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap}
  .fbtn{border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:20px;padding:7px 15px;font-size:12.5px;font-weight:600;cursor:pointer;font-family:inherit}
  .fbtn.on{background:var(--accent);color:var(--accent-fg);border-color:var(--line2)}
  .svcs{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px;align-items:center}
  .svcs .lb{font-size:11px;color:var(--sub);font-weight:700;letter-spacing:.04em}
  .schip{border:1px dashed var(--line);background:transparent;color:var(--muted);border-radius:14px;padding:4px 11px;font-size:11.5px;font-weight:700;cursor:pointer;font-family:inherit;transition:.15s}
  .schip:hover{border-color:var(--line2);color:var(--fg)}
  .schip.on{background:var(--accent);color:var(--accent-fg);border:1px solid var(--line2)}
  .schip:disabled{opacity:.4;cursor:default}
  @media(max-width:560px){.u{flex-wrap:wrap}.u .acts{width:100%;justify-content:flex-start;padding-left:53px}}
`;

export async function onRequestGet({ env }) {
  const chrome = await getChrome(env);
  const body =
    '<div id="root"><div class="gate"><div class="spin"></div></div></div>\n' +
    '<script>' + MEMBER_JS + '</script>\n' +
    '<script>' + MEMBERS_JS + '</script>';
  return html(pageShell({
    title: "成員管理",
    tkey: "page.members",
    desc: "站長專用的成員管理頁。",
    noindex: true,
    chrome: chrome,
    activePath: "/members",
    h1: '<a href="/" data-zh="成員管理" data-en="Members">成員管理</a>',
    headExtra: "<style>" + MEMBER_CSS + PAGE_CSS + "</style>\n",
    body: body
  }));
}

const MEMBERS_JS = `
(function(){
  "use strict";
  var $=MU.$,el=MU.el,tx=MU.tx,esc=MU.esc;
  var root=$("root"),me=null,rows=[],filter="all";

  function api(path,opts){
    opts=opts||{};opts.headers=opts.headers||{};
    if(opts.json!==undefined){opts.method=opts.method||"POST";opts.headers["content-type"]="application/json";opts.body=JSON.stringify(opts.json);delete opts.json;}
    return fetch(path,opts).then(function(r){return r.json().catch(function(){return{};}).then(function(d){if(!r.ok)throw new Error(d.hint||d.error||("HTTP "+r.status));return d;});});
  }

  function paint(){
    if(!me){MU.gateLogin(root,tx("成員管理","Members"),tx("這一頁只有站長能看，請先登入。","Owner only. Please sign in."));return;}
    if(!me.is_admin){
      root.innerHTML="";root.appendChild(MU.acctCard(me));
      var g=el("div","gate");g.appendChild(el("div","big","\\uD83D\\uDEAB"));
      g.appendChild(el("h2",null,tx("僅限站長","Owner only")));
      g.appendChild(el("p",null,tx("這一頁只有站長能看。","This page is for the site owner only.")));
      root.appendChild(g);return;
    }
    render();
  }
  function start(){
    MU.me(true).then(function(u){ me=u; if(me&&me.is_admin){load();} else {paint();} })
      .catch(function(e){root.innerHTML='<div class="gate"><p>'+esc(e.message||e)+'</p></div>';});
  }
  MU.onLang(paint);

  function load(){
    api("/api/admin/users").then(function(d){rows=d.rows||[];render();}).catch(function(e){
      root.innerHTML='<div class="gate"><p>'+esc(e.message||e)+'</p></div>';
    });
  }

  function fmt(iso){if(!iso)return "—";var d=new Date(iso);return isNaN(d)?"—":d.toLocaleString();}

  function render(){
    root.innerHTML="";
    // 篩選列
    var counts={all:rows.length,pending:0,approved:0,blocked:0};
    rows.forEach(function(r){counts[r.status]=(counts[r.status]||0)+1;});
    var fl=el("div","filters");
    [["all",tx("全部","All")],["pending",tx("待核准","Pending")],["approved",tx("已核准","Approved")],["blocked",tx("已封鎖","Blocked")]].forEach(function(f){
      var b=el("button","fbtn"+(filter===f[0]?" on":""),f[1]+" ("+(counts[f[0]]||0)+")");
      b.addEventListener("click",function(){filter=f[0];render();});
      fl.appendChild(b);
    });
    root.appendChild(fl);

    var list=rows.filter(function(r){return filter==="all"||r.status===filter;});
    if(!list.length){var g=el("div","gate");g.appendChild(el("p",null,tx("沒有符合的帳號。","No matching accounts.")));root.appendChild(g);return;}

    var card=el("div","card");
    list.forEach(function(r){card.appendChild(userRow(r));});
    root.appendChild(card);
  }

  function userRow(r){
    var row=el("div","u");
    var img=el("img");img.alt="";img.referrerPolicy="no-referrer";
    img.src=r.picture||("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 40'%3E%3Crect width='40' height='40' fill='%23ccc'/%3E%3C/svg%3E");
    row.appendChild(img);
    var info=el("div","info");
    var nm=el("div","nm");nm.appendChild(document.createTextNode((r.name||r.email)+"  "));
    MU.badge(r).forEach(function(b){nm.appendChild(b);nm.appendChild(document.createTextNode(" "));});
    info.appendChild(nm);
    info.appendChild(el("div","em",r.email));
    info.appendChild(el("div","st",
      tx("登入：","Login: ")+fmt(r.last_login)+
      "  ·  "+tx("中轉","relay")+" "+(r.relay_calls||0)+
      "  ·  "+tx("訂閱","vpn")+" "+(r.vpn_pulls||0)));
    info.appendChild(svcChips(r));
    row.appendChild(info);

    var acts=el("div","acts");
    function act(label,action,cls){
      var b=el("button","mbtn"+(cls?" "+cls:""),label);
      b.addEventListener("click",function(){doAct(r,action,b);});
      acts.appendChild(b);
    }
    var confirmDel=r.email;
    if(r.status==="pending")act(tx("批准全部服務","Approve all"),"approve","pri");
    if(r.status==="approved"&&!r.is_admin)act(tx("封鎖","Block"),"block");
    if(r.status==="blocked")act(tx("解封","Unblock"),"unblock","pri");
    if(!r.is_admin&&r.status!=="blocked")act(tx("設為站長","Make admin"),"make_admin");
    if(r.is_admin&&(!me||me.id!==r.id))act(tx("取消站長","Drop admin"),"drop_admin");
    if(!me||me.id!==r.id){
      var del=el("button","mbtn danger",tx("刪除","Delete"));
      del.addEventListener("click",function(){
        if(!confirm(tx("刪除帳號 "+confirmDel+"？此動作無法復原。","Delete "+confirmDel+"? This cannot be undone.")))return;
        api("/api/admin/users/"+r.id,{method:"DELETE"}).then(function(){MU.flash(tx("已刪除","Deleted"));load();}).catch(function(e){MU.flash(esc(e.message||e));});
      });
      acts.appendChild(del);
    }
    row.appendChild(acts);
    return row;
  }

  function doAct(r,action,btn){
    btn.disabled=true;
    api("/api/admin/users/"+r.id,{method:"PUT",json:{action:action}})
      .then(function(){MU.flash(tx("已更新","Updated"));load();})
      .catch(function(e){btn.disabled=false;MU.flash(esc(e.message||e));});
  }

  // 分服務批准：每個會員三顆服務開關（實心＝已批准），點一下切換。
  // 站長帳號不用開關（天生全通）；封鎖中的帳號開關鎖住（先解封再說）。
  var SVC=[["playground","Playground"],["relay",null],["vpn","VPN"]];
  function svcChips(r){
    var box=el("div","svcs");
    box.appendChild(el("span","lb",tx("服務","SERVICES")));
    if(r.is_admin){box.appendChild(el("span","muted",tx("站長＝全部服務","admin = all services")));return box;}
    var cur=String(r.services||"").split(",").filter(Boolean);
    SVC.forEach(function(s){
      var label=s[1]||(s[0]==="relay"?tx("中轉站","Relay"):s[0]);
      var on=cur.indexOf(s[0])>=0;
      var b=el("button","schip"+(on?" on":""),(on?"✓ ":"")+label);
      b.title=on?tx("點一下收回","Click to revoke"):tx("點一下批准","Click to grant");
      if(r.status==="blocked")b.disabled=true;
      b.addEventListener("click",function(){
        var next=on?cur.filter(function(x){return x!==s[0];}):cur.concat([s[0]]);
        b.disabled=true;
        api("/api/admin/users/"+r.id,{method:"PUT",json:{action:"set_services",services:next}})
          .then(function(){MU.flash(tx("已更新","Updated"));load();})
          .catch(function(e){b.disabled=false;MU.flash(esc(e.message||e));});
      });
      box.appendChild(b);
    });
    return box;
  }

  start();
})();
`;
