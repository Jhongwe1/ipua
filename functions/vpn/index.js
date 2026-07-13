// GET /vpn — VPN 訂閱（會員頁）。
// 未登入 → 登入閘門；待核准 → 提示等核准；已核准 → 顯示專屬訂閱網址＋複製鈕＋一鍵匯入＋教學。
// 站長另外看到「訂閱來源設定」卡：上游訂閱網址＋手動節點（存 settings 表）。
// 訂閱內容由 functions/vpn/sub/<token> 產生（驗 token→抓上游→轉發）。
import { html, pageShell, getChrome } from "../../lib/site.js";
import { MEMBER_CSS, MEMBER_JS } from "../../lib/memberui.js";

const PAGE_CSS = `
  .card{border:1px solid var(--line);border-radius:13px;padding:16px 18px;margin-bottom:16px;background:var(--card)}
  .card h2{font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:0 0 12px;padding-bottom:9px;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;gap:8px}
  .btn.danger:hover{border-color:#c33;color:#c33}
  .tag{font-size:10.5px;font-weight:700;border:1px solid var(--line);border-radius:5px;padding:1px 6px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
  .chk{display:flex;align-items:center;gap:8px;font-size:13.5px;margin-bottom:12px;cursor:pointer}
  .chk input{width:auto}
  .btn{border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:8px;padding:9px 15px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;transition:.15s;white-space:nowrap;text-decoration:none;display:inline-flex;align-items:center;gap:6px}
  .btn:hover{border-color:var(--line2)}
  .btn.pri{background:var(--accent);color:var(--accent-fg);border-color:var(--line2)}
  .btn:disabled{opacity:.5;cursor:default}
  .field{margin-bottom:12px}
  .field label{display:block;font-size:12px;font-weight:700;color:var(--muted);letter-spacing:.05em;margin-bottom:5px}
  .field input,.field textarea{width:100%;border:1px solid var(--line);background:var(--field);color:var(--fg);border-radius:8px;padding:10px 11px;font-size:14px;font-family:inherit;outline:none;box-sizing:border-box}
  .field textarea{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12.5px;line-height:1.6;resize:vertical}
  .field input:focus,.field textarea:focus{border-color:var(--line2)}
  .btnrow{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
  ol.steps{margin:0;padding-left:20px;font-size:13.5px;line-height:1.9;color:var(--muted)}
  ol.steps code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;background:var(--field);border:1px solid var(--line);border-radius:5px;padding:1px 6px}
`;

export async function onRequestGet({ env }) {
  const chrome = await getChrome(env);
  const body =
    '<div id="root"><div class="gate"><div class="spin"></div></div></div>\n' +
    '<script>' + MEMBER_JS + '</script>\n' +
    '<script>' + VPN_JS + '</script>';
  return html(pageShell({
    title: "VPN",
    tkey: "page.vpn",
    desc: "會員專用的 VPN 訂閱 — 一個網址匯入所有節點，自動更新。",
    noindex: true,
    chrome: chrome,
    activePath: "/vpn",
    h1: '<a href="/" data-zh="VPN" data-en="VPN">VPN</a>',
    headExtra: "<style>" + MEMBER_CSS + PAGE_CSS + "</style>\n",
    body: body
  }));
}

const VPN_JS = `
(function(){
  "use strict";
  var $=MU.$,el=MU.el,tx=MU.tx,esc=MU.esc,origin=MU.origin;
  var root=$("root"),me=null;

  function api(path,opts){
    opts=opts||{};opts.headers=opts.headers||{};
    if(opts.json!==undefined){opts.method=opts.method||"POST";opts.headers["content-type"]="application/json";opts.body=JSON.stringify(opts.json);delete opts.json;}
    return fetch(path,opts).then(function(r){return r.json().catch(function(){return{};}).then(function(d){if(!r.ok)throw new Error(d.hint||d.error||("HTTP "+r.status));return d;});});
  }
  function subUrl(){return origin+"/vpn/sub/"+me.vpn_token;}

  function paint(){
    if(!me){MU.gateLogin(root,tx("VPN","VPN"),tx("一個訂閱網址匯入所有節點、自動更新。請先用 Google 登入。","One subscription URL for all nodes. Please sign in with Google first."));return;}
    // 分服務批准：要有 vpn 服務才能用這一頁
    if((me.services||[]).indexOf("vpn")<0){MU.gatePending(root,me);return;}
    render();
  }
  function start(){
    MU.me(true).then(function(u){ me=u; paint(); })
      .catch(function(e){root.innerHTML='<div class="gate"><p>'+tx("讀取失敗：","Failed: ")+esc(e.message||e)+'</p></div>';});
  }
  MU.onLang(paint);

  function render(){
    root.innerHTML="";
    root.appendChild(MU.acctCard(me));

    // 訂閱網址卡
    var sc=el("div","card");
    sc.appendChild(el("h2",null,tx("你的訂閱網址","Your subscription URL")));
    sc.appendChild(el("p","lead",tx("把這個網址加進 Clash／v2rayN／Shadowrocket 等 App 的「訂閱」，就會自動拿到全部節點並定時更新。這網址等於你的通行證，別分享給別人。","Add this URL to Clash / v2rayN / Shadowrocket as a subscription. It's your personal pass — don't share it.")));
    var kbox=el("div","kbox");
    var code=el("div","code");code.id="subView";code.textContent=subUrl();
    kbox.appendChild(code);
    var cp=el("button","copy2",tx("複製","Copy"));
    MU.copyBtn(cp,subUrl);
    kbox.appendChild(cp);
    sc.appendChild(kbox);
    // 一鍵匯入（clash 深連結）＋重設
    var br=el("div","btnrow");
    var imp=el("a","btn pri",tx("匯入到 Clash","Import to Clash"));
    imp.href="clash://install-config?url="+encodeURIComponent(subUrl())+"&name=uaip";
    br.appendChild(imp);
    var reset=el("button","btn",tx("重設網址","Reset URL"));
    reset.addEventListener("click",function(){
      if(!confirm(tx("重設後舊的訂閱網址會立刻失效，你 App 裡要重新匯入。確定？","Old URL stops working immediately and you'll need to re-import. Continue?")))return;
      reset.disabled=true;
      api("/api/account/vpn-token",{method:"POST"}).then(function(d){
        me.vpn_token=d.vpn_token;code.textContent=subUrl();imp.href="clash://install-config?url="+encodeURIComponent(subUrl())+"&name=uaip";
        reset.disabled=false;MU.flash(tx("已重設","Reset"));
      }).catch(function(e){reset.disabled=false;MU.flash(esc(e.message||e));});
    });
    br.appendChild(reset);
    sc.appendChild(br);
    root.appendChild(sc);

    // 教學卡
    var hc=el("div","card");
    hc.appendChild(el("h2",null,tx("怎麼用","How to use")));
    var ol=el("ol","steps");
    [tx("複製上面的訂閱網址。","Copy the subscription URL above."),
     tx("打開你的 App（Clash Verge／v2rayN／Clash Meta／Shadowrocket…）。","Open your app (Clash Verge / v2rayN / Shadowrocket…)."),
     tx("找到「訂閱 / Profiles / Subscribe」，貼上網址、命名後匯入。","Find Subscriptions / Profiles, paste the URL, name it, import."),
     tx("之後 App 會定時自動更新節點，你不用再手動貼。","The app auto-updates nodes on a schedule from now on.")].forEach(function(s){
      ol.appendChild(el("li",null,s));
    });
    hc.appendChild(ol);
    root.appendChild(hc);

    if(me.is_admin)root.appendChild(adminCard());
  }

  /* ===== 站長：渠道管理（多上游，會員看不到） ===== */
  function adminCard(){
    var card=el("div","card");
    var h=el("h2");h.appendChild(document.createTextNode(tx("渠道管理（站長）","Channels admin")));
    var add=el("button","btn pri",tx("＋ 新增","＋ Add"));
    h.appendChild(add);card.appendChild(h);
    card.appendChild(el("p","lead",tx("找到便宜的機場就加進來：會員的訂閱網址不變，伺服器自動合併所有「啟用中」渠道的節點，會員看不到上游。只開一個訂閱渠道時原樣轉發（含流量資訊、支援 Clash YAML）；開兩個以上會合併成 base64 節點訂閱（v2rayN／Shadowrocket／NekoBox 都吃）。","Add cheap upstreams here. Members keep one URL; the server merges nodes from every enabled channel and upstreams stay hidden. With one sub channel content is passed through as-is; with several they're merged into a base64 node list.")));
    var box=el("div");card.appendChild(box);
    reloadAdmin(box);
    add.addEventListener("click",function(){editChannel(null,box);});
    return card;
  }
  function reloadAdmin(box){
    api("/api/admin/vpn/channels").then(function(d){
      box.innerHTML="";
      var rows=d.rows||[];
      if(!rows.length){box.appendChild(el("p","muted",tx("還沒有渠道，按「＋ 新增」貼上第一個機場訂閱或節點。","No channels yet.")));return;}
      rows.forEach(function(c){
        var row=el("div","rowline");
        var g=el("div","g");
        var t1=el("div","t1");
        t1.appendChild(document.createTextNode((c.enabled?"":tx("（停用）","(off) "))+c.name+"  "));
        t1.appendChild(el("span","tag",c.kind==="sub"?tx("訂閱","sub"):tx("節點","nodes")));
        g.appendChild(t1);
        var t2=el("div","t2");
        t2.textContent=c.kind==="sub"
          ?(c.has_url?tx("上游：","upstream: ")+c.url_hint:tx("⚠ 沒填網址","⚠ no URL"))
          :tx("手動節點 ","manual nodes ")+c.node_count+tx(" 條"," lines");
        g.appendChild(t2);row.appendChild(g);
        var tg=el("button","btn",c.enabled?tx("停用","Disable"):tx("啟用","Enable"));
        tg.addEventListener("click",function(){
          tg.disabled=true;
          api("/api/admin/vpn/channels/"+c.id,{method:"PUT",json:{name:c.name,kind:c.kind,nodes:c.nodes,enabled:!c.enabled}})
            .then(function(){reloadAdmin(box);MU.flash(c.enabled?tx("已停用","Disabled"):tx("已啟用","Enabled"));})
            .catch(function(e){tg.disabled=false;MU.flash(esc(e.message||e));});
        });
        var ed=el("button","btn",tx("編輯","Edit"));ed.addEventListener("click",function(){editChannel(c,box);});
        var del=el("button","btn danger",tx("刪除","Delete"));
        del.addEventListener("click",function(){
          if(!confirm(tx("刪除渠道「"+c.name+"」？會員的訂閱會立刻少掉這些節點。","Delete channel?")))return;
          api("/api/admin/vpn/channels/"+c.id,{method:"DELETE"}).then(function(){reloadAdmin(box);MU.flash(tx("已刪除","Deleted"));}).catch(function(e){MU.flash(esc(e.message||e));});
        });
        row.appendChild(tg);row.appendChild(ed);row.appendChild(del);
        box.appendChild(row);
      });
    }).catch(function(e){box.innerHTML='<p class="muted">'+esc(e.message||e)+'</p>';});
  }
  function editChannel(c,box){
    var isNew=!c;c=c||{kind:"sub",enabled:1,nodes:""};
    var ov=el("div");ov.style.cssText="position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:120;display:flex;align-items:center;justify-content:center;padding:16px";
    var dlg=el("div","card");dlg.style.cssText="max-width:440px;width:100%;margin:0;max-height:90vh;overflow:auto";
    dlg.appendChild(el("h2",null,isNew?tx("新增渠道","New channel"):tx("編輯渠道","Edit channel")));
    var fN=el("div","field");fN.appendChild(el("label",null,tx("顯示名稱（只有你看得到）","Name (admin only)")));
    var fName=el("input");fName.value=c.name||"";fName.placeholder=tx("例：某機場 月付3元","e.g. cheap airport");fName.autocomplete="off";
    fN.appendChild(fName);dlg.appendChild(fN);
    // 類型
    var kf=el("div","field");kf.appendChild(el("label",null,tx("類型","Kind")));
    var sel=el("select");
    [["sub",tx("訂閱網址（機場給的連結）","Subscription URL")],["nodes",tx("手動節點（自己貼連結）","Manual nodes")]].forEach(function(p){
      var o=el("option",null,p[1]);o.value=p[0];if(c.kind===p[0])o.selected=true;sel.appendChild(o);
    });
    kf.appendChild(sel);dlg.appendChild(kf);
    // 訂閱網址（kind=sub）
    var fU=el("div","field");fU.appendChild(el("label",null,tx("上游訂閱網址","Upstream subscription URL")));
    var fUrl=el("input");fUrl.autocomplete="off";
    fUrl.placeholder=c.has_url?tx("（留空＝不變；目前 "+c.url_hint+"）","(blank = keep)"):"https://…";
    fU.appendChild(fUrl);dlg.appendChild(fU);
    // 手動節點（kind=nodes）
    var fM=el("div","field");fM.appendChild(el("label",null,tx("節點連結（一行一條）","Node links (one per line)")));
    var fNodes=el("textarea");fNodes.rows=5;fNodes.placeholder="vless://…\\nvmess://…";fNodes.value=c.nodes||"";
    fM.appendChild(fNodes);dlg.appendChild(fM);
    function swap(){fU.style.display=sel.value==="sub"?"":"none";fM.style.display=sel.value==="nodes"?"":"none";}
    sel.addEventListener("change",swap);swap();
    // 啟用
    var ck=el("label","chk");
    var cb=el("input");cb.type="checkbox";cb.checked=!!c.enabled;
    ck.appendChild(cb);ck.appendChild(document.createTextNode(tx("啟用（節點併入會員訂閱）","Enabled")));
    dlg.appendChild(ck);
    var btns=el("div");btns.style.cssText="display:flex;gap:8px;justify-content:flex-end;margin-top:6px";
    var cancel=el("button","btn",tx("取消","Cancel"));
    var save=el("button","btn pri",tx("儲存","Save"));
    btns.appendChild(cancel);btns.appendChild(save);dlg.appendChild(btns);
    ov.appendChild(dlg);document.body.appendChild(ov);
    fName.focus();
    function close(){ov.remove();}
    cancel.addEventListener("click",close);
    ov.addEventListener("click",function(e){if(e.target===ov)close();});
    save.addEventListener("click",function(){
      var payload={name:fName.value.trim(),kind:sel.value,nodes:fNodes.value,enabled:cb.checked};
      if(fUrl.value.trim()!=="")payload.url=fUrl.value.trim();   // 空＝不帶＝保留舊值（編輯）
      else if(isNew)payload.url="";
      save.disabled=true;save.textContent=tx("儲存中…","Saving…");
      var p=isNew?api("/api/admin/vpn/channels",{json:payload})
                 :api("/api/admin/vpn/channels/"+c.id,{method:"PUT",json:payload});
      p.then(function(){close();reloadAdmin(box);MU.flash(tx("已儲存","Saved"));}).catch(function(e){
        save.disabled=false;save.textContent=tx("儲存","Save");MU.flash(esc(e.message||e));
      });
    });
  }

  start();
})();
`;
