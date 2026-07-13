// GET /relay — API 中轉站（會員頁）。
// 未登入 → 登入閘門；待核准 → 提示等核准；已核准 → 顯示自己的金鑰、可用管道與接法範例。
// 站長另外看到「管道管理」卡：新增／編輯／刪除上游管道（存 relay_channels 表）。
// 真正的轉發在 functions/relay/[[path]].js；這頁只是操作面板，所有寫入都打 API。
import { html, pageShell, getChrome } from "./site.js";
import { MEMBER_CSS, MEMBER_JS } from "./memberui.js";

const PAGE_CSS = `
  .card{border:1px solid var(--line);border-radius:13px;padding:16px 18px;margin-bottom:16px;background:var(--card)}
  .card h2{font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:0 0 12px;padding-bottom:9px;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;gap:8px}
  .btn{border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:8px;padding:9px 15px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;transition:.15s;white-space:nowrap}
  .btn:hover{border-color:var(--line2)}
  .btn.pri{background:var(--accent);color:var(--accent-fg);border-color:var(--line2)}
  .btn.danger:hover{border-color:#c33;color:#c33}
  .btn:disabled{opacity:.5;cursor:default}
  .field{margin-bottom:12px}
  .field label{display:block;font-size:12px;font-weight:700;color:var(--muted);letter-spacing:.05em;margin-bottom:5px}
  .field input,.field select{width:100%;border:1px solid var(--line);background:var(--field);color:var(--fg);border-radius:8px;padding:10px 11px;font-size:14px;font-family:inherit;outline:none;box-sizing:border-box}
  .field input:focus,.field select:focus{border-color:var(--line2)}
  .grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  @media(max-width:560px){.grid2{grid-template-columns:1fr}}
  .chlist .rowline .t2 code{font-size:11.5px}
  .tag{font-size:10.5px;font-weight:700;border:1px solid var(--line);border-radius:5px;padding:1px 6px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
  .mrow{display:flex;gap:6px;flex-wrap:wrap;margin-top:7px}
  .mchip{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--line);background:var(--field);color:var(--fg);border-radius:7px;padding:4px 9px;font-size:12px;font-weight:600;cursor:pointer;font-family:ui-monospace,Menlo,Consolas,monospace;transition:.15s}
  .mchip:hover{border-color:var(--line2)}
  .mchip .cp{opacity:.55;font-family:inherit}
  .field textarea{width:100%;border:1px solid var(--line);background:var(--field);color:var(--fg);border-radius:8px;padding:10px 11px;font-size:13px;font-family:ui-monospace,Menlo,Consolas,monospace;line-height:1.7;outline:none;box-sizing:border-box;resize:vertical}
  .field textarea:focus{border-color:var(--line2)}
  .egtabs{display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap}
  .egtab{border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:7px;padding:6px 12px;font-size:12.5px;font-weight:600;cursor:pointer;font-family:inherit}
  .egtab.on{background:var(--accent);color:var(--accent-fg);border-color:var(--line2)}
`;

export async function relayPageResponse(env) {
  const chrome = await getChrome(env);
  const body =
    '<div id="root"><div class="gate"><div class="spin"></div></div></div>\n' +
    '<script>' + MEMBER_JS + '</script>\n' +
    '<script>' + RELAY_JS + '</script>';
  return html(pageShell({
    title: "API 中轉站",
    tkey: "page.relay",
    desc: "會員專用的 API 中轉站 — 用一把金鑰、一個網址接上各家 AI API。",
    noindex: true,
    chrome: chrome,
    activePath: "/relay",
    h1: '<a href="/" data-zh="API 中轉站" data-en="API relay">API 中轉站</a>',
    headExtra: "<style>" + MEMBER_CSS + PAGE_CSS + "</style>\n",
    body: body
  }));
}

const RELAY_JS = `
(function(){
  "use strict";
  var $=MU.$,el=MU.el,tx=MU.tx,esc=MU.esc,origin=MU.origin;
  var root=$("root"),me=null,channels=[];

  function api(path,opts){
    opts=opts||{};opts.headers=opts.headers||{};
    if(opts.json!==undefined){opts.method=opts.method||"POST";opts.headers["content-type"]="application/json";opts.body=JSON.stringify(opts.json);delete opts.json;}
    return fetch(path,opts).then(function(r){
      return r.json().catch(function(){return{};}).then(function(d){
        if(!r.ok)throw new Error(d.hint||d.error||("HTTP "+r.status));
        return d;
      });
    });
  }

  // 分服務批准：要有 relay 服務才能用這一頁
  function canUse(){return !!(me&&(me.services||[]).indexOf("relay")>=0);}
  // 依目前狀態畫面（切語言時直接重畫，不重打 API）
  function paint(){
    if(!me){MU.gateLogin(root,tx("API 中轉站","API relay"),tx("用一把金鑰接上各家 AI API（OpenAI、Claude、Gemini、本地模型…）。請先用 Google 登入。","One key for many AI APIs. Please sign in with Google first."));return;}
    if(!canUse()){MU.gatePending(root,me);return;}
    render();
  }
  function start(){
    MU.me(true).then(function(u){
      me=u;
      if(canUse()){
        return fetch("/api/relay/channels",{cache:"no-store"}).then(function(r){return r.json();}).then(function(d){channels=d.rows||[];paint();});
      }
      paint();
    }).catch(function(e){root.innerHTML='<div class="gate"><p>'+tx("讀取失敗：","Failed: ")+esc(e.message||e)+'</p></div>';});
  }
  MU.onLang(paint);

  function render(){
    root.innerHTML="";
    root.appendChild(MU.acctCard(me));

    // 金鑰卡
    var kc=el("div","card");
    var h=el("h2",null,tx("你的中轉金鑰","Your relay key"));
    kc.appendChild(h);
    kc.appendChild(el("p","lead",tx("把 AI 工具的 API Key 換成這一把、Base URL 換成下面管道的網址即可。金鑰只在產生當下顯示一次。","Use this as your API key and the channel URL below as the base URL. The key is shown only once when generated.")));
    var kbox=el("div","kbox");
    var codeEl=el("div","code");
    codeEl.id="keyView";
    codeEl.textContent=me.has_key?(tx("目前金鑰：","Current: ")+me.key_hint):tx("尚未產生金鑰","No key yet");
    kbox.appendChild(codeEl);
    var gen=el("button","copy2",me.has_key?tx("重新產生","Regenerate"):tx("產生金鑰","Generate"));
    kbox.appendChild(gen);
    kc.appendChild(kbox);
    var note=el("div","muted");note.style.marginTop="8px";
    note.textContent=me.has_key&&me.key_at?tx("上次產生：","Last generated: ")+new Date(me.key_at).toLocaleString():"";
    kc.appendChild(note);
    root.appendChild(kc);

    gen.addEventListener("click",function(){
      if(me.has_key&&!confirm(tx("重新產生會讓舊金鑰立刻失效，確定？","Regenerating will immediately invalidate the old key. Continue?")))return;
      gen.disabled=true;gen.textContent=tx("產生中…","Working…");
      api("/api/account/key",{method:"POST"}).then(function(d){
        // 明文金鑰只回這一次：整顆顯示＋一鍵複製
        codeEl.textContent=d.key;
        var cp=el("button","copy2 ghosty",tx("複製","Copy"));
        MU.copyBtn(cp,d.key);
        // 換掉按鈕
        gen.replaceWith(cp);
        me.has_key=true;me.key_hint=d.key_hint;me.key_at=d.key_at;
        note.textContent=tx("已產生 — 請立刻複製保存，離開後只會看到提示。","Generated — copy it now; you won't see it again.");
        MU.flash(tx("金鑰已產生","Key generated"));
      }).catch(function(e){gen.disabled=false;gen.textContent=tx("重新產生","Regenerate");MU.flash(esc(e.message||e));});
    });

    // 管道卡
    var cc=el("div","card");
    cc.appendChild(el("h2",null,tx("可用管道","Channels")));
    if(!channels.length){
      cc.appendChild(el("p","muted",tx("站長還沒設定任何上游管道。","No upstream channels configured yet.")));
    }else{
      var list=el("div","chlist");
      channels.forEach(function(c){
        var row=el("div","rowline");
        var g=el("div","g");
        var t1=el("div","t1");t1.appendChild(document.createTextNode(c.name+"  "));
        var tag=el("span","tag",c.kind);t1.appendChild(tag);
        g.appendChild(t1);
        var t2=el("div","t2");
        t2.innerHTML="<code>"+esc(origin)+"/relay/"+esc(c.slug)+"</code>";
        g.appendChild(t2);
        // 模型名稱：一顆一顆的複製鈕（點一下就複製，直接貼到 App 的 model 欄位）
        if(c.models&&c.models.length){
          var mr=el("div","mrow");
          c.models.forEach(function(m){
            var chip=el("button","mchip");
            chip.appendChild(document.createTextNode(m));
            chip.appendChild(el("span","cp","⧉"));
            chip.title=tx("複製模型名稱","Copy model name");
            MU.copyBtn(chip,m);
            mr.appendChild(chip);
          });
          g.appendChild(mr);
        }
        row.appendChild(g);
        var cp=el("button","btn",tx("複製網址","Copy URL"));
        MU.copyBtn(cp,origin+"/relay/"+c.slug);
        row.appendChild(cp);
        list.appendChild(row);
      });
      cc.appendChild(list);
    }
    root.appendChild(cc);

    // 範例卡
    if(channels.length)root.appendChild(exampleCard());

    // 站長：管道管理
    if(me.is_admin)root.appendChild(adminCard());
  }

  function exampleCard(){
    var c=channels[0];
    var base=origin+"/relay/"+c.slug;
    var key=me.key_hint||"uak-…";
    var mdl=(c.models&&c.models[0])||"gpt-4o-mini";
    var card=el("div","card");
    card.appendChild(el("h2",null,tx("怎麼接（範例）","How to connect")));
    var egs={
      openai:"curl "+base+"/v1/chat/completions \\\\\\n  -H \\"Authorization: Bearer "+key+"\\" \\\\\\n  -H \\"content-type: application/json\\" \\\\\\n  -d '{\\"model\\":\\""+mdl+"\\",\\"messages\\":[{\\"role\\":\\"user\\",\\"content\\":\\"hi\\"}]}'",
      python:"from openai import OpenAI\\nclient = OpenAI(\\n    base_url=\\""+base+"/v1\\",\\n    api_key=\\""+key+"\\",\\n)\\nr = client.chat.completions.create(\\n    model=\\""+mdl+"\\",\\n    messages=[{\\"role\\":\\"user\\",\\"content\\":\\"hi\\"}],\\n)",
      app:tx("在 App／外掛的設定裡：\\n  • API Base URL（或 Host）填： ","In your app/extension settings:\\n  • API Base URL: ")+base+tx("\\n  • API Key 填你上面那把 uak- 金鑰\\n（OpenAI 相容欄位通常會自動補 /v1）","\\n  • API Key: your uak- key above")
    };
    var tabs=el("div","egtabs");
    var pre=el("pre","code");
    var names={openai:"curl",python:"Python",app:tx("App 設定","App")};
    ["openai","python","app"].forEach(function(k,i){
      var b=el("button","egtab"+(i===0?" on":""),names[k]);
      b.addEventListener("click",function(){
        [].forEach.call(tabs.children,function(x){x.classList.remove("on");});
        b.classList.add("on");pre.textContent=egs[k];
      });
      tabs.appendChild(b);
    });
    pre.textContent=egs.openai;
    card.appendChild(tabs);card.appendChild(pre);
    var note=el("div","muted");note.style.marginTop="10px";
    note.textContent=tx("Claude 用管道會走 /v1/messages，Gemini 走 /v1beta/models/…；路徑照上游原本的填，中轉只換金鑰不改路徑。","Anthropic uses /v1/messages, Gemini /v1beta/…; keep the upstream path as-is.");
    card.appendChild(note);
    return card;
  }

  /* ===== 站長：管道管理 ===== */
  function adminCard(){
    var card=el("div","card");
    var h=el("h2");h.appendChild(document.createTextNode(tx("管道管理（站長）","Channels admin")));
    var add=el("button","btn pri",tx("＋ 新增","＋ Add"));
    h.appendChild(add);card.appendChild(h);
    var box=el("div");card.appendChild(box);
    reloadAdmin(box);
    add.addEventListener("click",function(){editChannel(null,box);});
    return card;
  }
  function reloadAdmin(box){
    api("/api/admin/relay/channels").then(function(d){
      box.innerHTML="";
      var rows=d.rows||[];
      if(!rows.length){box.appendChild(el("p","muted",tx("還沒有管道，按「＋ 新增」建立第一個。","No channels yet.")));return;}
      rows.forEach(function(c){
        var row=el("div","rowline");
        var g=el("div","g");
        var t1=el("div","t1");
        t1.appendChild(document.createTextNode((c.enabled?"":"（停用）")+c.name+"  "));
        t1.appendChild(el("span","tag",c.kind));
        g.appendChild(t1);
        var t2=el("div","t2");
        t2.textContent="/relay/"+c.slug+" → "+c.base_url+"  ·  "+(c.has_key?tx("金鑰：","key: ")+c.key_hint:tx("⚠ 未設金鑰","⚠ no key"));
        g.appendChild(t2);
        var t3=el("div","t2");
        t3.textContent=(c.models&&c.models.length)
          ?tx("模型：","models: ")+c.models.join(", ")
          :tx("⚠ 還沒設定模型名稱（編輯補上）","⚠ no models yet");
        g.appendChild(t3);row.appendChild(g);
        var tg=el("button","btn",c.enabled?tx("停用","Disable"):tx("啟用","Enable"));
        tg.addEventListener("click",function(){
          tg.disabled=true;
          api("/api/admin/relay/channels/"+c.id,{method:"PUT",json:{name:c.name,slug:c.slug,kind:c.kind,base_url:c.base_url,models:c.models,enabled:!c.enabled}})
            .then(function(){reloadAdmin(box);MU.flash(c.enabled?tx("已停用","Disabled"):tx("已啟用","Enabled"));})
            .catch(function(e){tg.disabled=false;MU.flash(esc(e.message||e));});
        });
        var ed=el("button","btn",tx("編輯","Edit"));ed.addEventListener("click",function(){editChannel(c,box);});
        var del=el("button","btn danger",tx("刪除","Delete"));
        del.addEventListener("click",function(){
          if(!confirm(tx("刪除管道「"+c.name+"」？","Delete channel?")))return;
          api("/api/admin/relay/channels/"+c.id,{method:"DELETE"}).then(function(){reloadAdmin(box);MU.flash(tx("已刪除","Deleted"));}).catch(function(e){MU.flash(esc(e.message||e));});
        });
        row.appendChild(tg);row.appendChild(ed);row.appendChild(del);
        box.appendChild(row);
      });
    }).catch(function(e){box.innerHTML='<p class="muted">'+esc(e.message||e)+'</p>';});
  }
  function editChannel(c,box){
    var isNew=!c;c=c||{kind:"openai",enabled:1};
    var ov=el("div");ov.className="ab-ov";ov.style.cssText="position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:120;display:flex;align-items:center;justify-content:center;padding:16px";
    var dlg=el("div","card");dlg.style.cssText="max-width:420px;width:100%;margin:0;max-height:90vh;overflow:auto";
    dlg.appendChild(el("h2",null,isNew?tx("新增管道","New channel"):tx("編輯管道","Edit channel")));
    function field(label,id,val,ph){
      var f=el("div","field");f.appendChild(el("label",null,label));
      var i=el("input");i.id=id;i.value=val||"";if(ph)i.placeholder=ph;i.autocomplete="off";f.appendChild(i);dlg.appendChild(f);return i;
    }
    var fName=field(tx("顯示名稱","Name"),"cName",c.name,"OpenAI");
    var fSlug=field(tx("網址代稱（slug）","Slug"),"cSlug",c.slug,"openai");
    if(!isNew)fSlug.disabled=false;
    // kind（決定金鑰怎麼帶給上游）
    var kf=el("div","field");kf.appendChild(el("label",null,tx("類型（決定金鑰怎麼帶給上游）","Kind")));
    var sel=el("select");
    [["openai",tx("OpenAI（含相容服務／本地模型）","OpenAI (and compatible)")],
     ["anthropic",tx("Anthropic（Claude）","Anthropic (Claude)")],
     ["gemini",tx("Google Gemini","Google Gemini")],
     ["custom",tx("自訂（OpenAI 相容介面）","Custom (OpenAI-compatible)")]].forEach(function(p){
      var o=el("option",null,p[1]);o.value=p[0];if(c.kind===p[0])o.selected=true;sel.appendChild(o);
    });
    kf.appendChild(sel);dlg.appendChild(kf);
    var fBase=field(tx("上游 Base URL","Base URL"),"cBase",c.base_url,"https://api.openai.com");
    // 模型名稱（必填）：一行一個；會員頁與 LLM Playground 都靠這份清單
    var mf=el("div","field");mf.appendChild(el("label",null,tx("模型名稱（一行一個，必填）","Models (one per line, required)")));
    var fModels=el("textarea");fModels.rows=3;fModels.placeholder="gpt-4o-mini\\ngpt-4o";
    fModels.value=(c.models||[]).join("\\n");
    mf.appendChild(fModels);dlg.appendChild(mf);
    var fKey=field(tx("上游 API Key","Upstream key"),"cKey","",c.has_key?tx("（留空＝不變；目前 "+c.key_hint+"）","(blank = keep)"):tx("上游平台給你的金鑰","upstream key"));
    fKey.type="password";

    // 選類型時自動帶入官方 Base URL；用其他供應商（便宜渠道／自架）直接改掉就好。
    // 只在「欄位是空的」或「裡面還是某個官方預設值」時才覆蓋 — 站長手打過的網址絕不動。
    var OFFICIAL={openai:"https://api.openai.com",anthropic:"https://api.anthropic.com",
                  gemini:"https://generativelanguage.googleapis.com",custom:""};
    function isOfficial(v){
      for(var k in OFFICIAL){if(OFFICIAL[k]&&OFFICIAL[k]===v)return true;}
      return false;
    }
    var hint=el("div","muted");hint.style.marginBottom="10px";
    function upKind(){
      var d=OFFICIAL[sel.value]||"";
      if(d&&(fBase.value===""||isOfficial(fBase.value)))fBase.value=d;
      fBase.placeholder=d||"https://api.某供應商.com";
      hint.textContent=d
        ?tx("已帶入官方預設網址 — 用其他供應商（便宜渠道、自架、本地模型）就直接改掉。","Official default filled in — replace it for other providers.")
        :tx("填該渠道的網址（OpenAI 相容介面即可，本地模型可用 http://…）。","Any OpenAI-compatible base URL (local models can use http://…).");
    }
    sel.addEventListener("change",upKind);upKind();
    dlg.appendChild(hint);
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
      var payload={name:fName.value.trim(),slug:fSlug.value.trim().toLowerCase(),kind:sel.value,base_url:fBase.value.trim(),models:fModels.value,enabled:isNew?1:!!c.enabled};
      if(fKey.value!=="")payload.api_key=fKey.value;      // 空＝不帶＝保留舊值（編輯）；新增時空＝空金鑰
      else if(isNew)payload.api_key="";
      save.disabled=true;save.textContent=tx("儲存中…","Saving…");
      var p=isNew?api("/api/admin/relay/channels",{json:payload})
                 :api("/api/admin/relay/channels/"+c.id,{method:"PUT",json:payload});
      p.then(function(){close();reloadAdmin(box);MU.flash(tx("已儲存","Saved"));}).catch(function(e){
        save.disabled=false;save.textContent=tx("儲存","Save");MU.flash(esc(e.message||e));
      });
    });
  }

  start();
})();
`;
