// GET /api-docs — API 文件頁（站長專用）。
// 跟 /logs、/admin 同一套金鑰閘門模式：頁面本身只是空殼＋金鑰輸入框，
// 文件內容要帶金鑰打 /api/admin/apidoc 才拿得到，再由瀏覽器端 marked 渲染 —
// 沒金鑰的人看不到文件內容。noindex、選單也只有站長裝置才會長出入口。
import { html, pageShell } from "../lib/site.js";
import { getChromeFor } from "../lib/chrome.js";

const GATE_CSS = `
  .gatecard{border:1px solid var(--line);border-radius:11px;padding:16px;background:var(--card);max-width:460px}
  .gatecard p{font-size:13px;color:var(--muted);margin:0 0 12px}
  .gatecard form{display:flex;gap:8px}
  .gatecard input{flex:1;border:1px solid var(--line);background:var(--field);color:var(--fg);border-radius:8px;padding:11px 12px;font-size:14px;font-family:inherit;outline:none}
  .gatecard input:focus{border-color:var(--line2)}
  .gatecard button{border:1px solid var(--line2);background:var(--accent);color:var(--accent-fg);border-radius:8px;padding:11px 20px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit}
  .gateerr{border:1px solid var(--line2);border-radius:8px;padding:10px 13px;margin-top:12px;font-size:13px}
  .docstate{color:var(--muted);font-size:13px;padding:8px 0}
`;

const GATE_JS = `
(function(){
  "use strict";
  var token="";
  try{ token=localStorage.getItem("ipua-logs-token")||""; }catch(e){}
  var gate=document.getElementById("docGate"),out=document.getElementById("docBody"),
      err=document.getElementById("docErr"),state=document.getElementById("docState");
  function load(){
    state.hidden=false; gate.hidden=true; err.hidden=true;
    var headers={};
    if(token)headers["Authorization"]="Bearer "+token;
    fetch("/api/admin/apidoc",{headers:headers,cache:"no-store"}).then(function(r){
      if(r.status===401)throw{auth:true};
      if(!r.ok)throw new Error("HTTP "+r.status);
      return r.json();
    }).then(function(d){
      try{ if(token)localStorage.setItem("ipua-logs-token",token); }catch(e){}
      state.hidden=true;
      out.innerHTML=window.marked?marked.parse(d.md||"",{gfm:true,breaks:false,async:false}):"";
      out.hidden=false;
    }).catch(function(e){
      state.hidden=true; out.hidden=true; gate.hidden=false;
      err.hidden=!(e&&e.auth&&token);
      var inp=document.getElementById("docToken"); if(inp)inp.focus();
    });
  }
  document.getElementById("docForm").addEventListener("submit",function(e){
    e.preventDefault();
    token=document.getElementById("docToken").value.trim();
    if(token)load();
  });
  load();
})();
`;

export async function onRequestGet({ request, env }) {
  const { chrome } = await getChromeFor(env, request);   // 選單依身分過濾（VPN 隱形）
  const body =
    '<style>' + GATE_CSS + '</style>\n' +
    '<div id="docGate" class="gatecard" hidden>\n' +
    '  <p>API 文件只開放站長閱讀。用站長 Google 帳號 <a href="/auth/login?next=/api-docs">登入</a>，或輸入管理金鑰（與 /logs、/admin 同一把）；金鑰只存在這台裝置的瀏覽器裡。</p>\n' +
    '  <form id="docForm"><input id="docToken" type="password" autocomplete="off" placeholder="管理金鑰"><button type="submit">進入</button></form>\n' +
    '  <div id="docErr" class="gateerr" hidden>⚠ 金鑰不正確，請再試一次。</div>\n' +
    '</div>\n' +
    '<div id="docState" class="docstate">讀取中…</div>\n' +
    '<article class="art"><div id="docBody" class="prose" hidden></div></article>\n' +
    '<script src="/assets/marked.js"><\/script>\n' +
    '<script>' + GATE_JS + '<\/script>';

  return html(pageShell({
    title: "API 文件",
    desc: "站長專用的 API 使用說明。",
    noindex: true,
    chrome: chrome,
    activePath: "/api-docs",
    h1: "API 文件",
    body: body
  }));
}
