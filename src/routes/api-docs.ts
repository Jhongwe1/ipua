// GET /api-docs — API 文件頁（v2.0.0 Phase L 起**公開**，noindex 保留；ADR-0010）。
// v1 是金鑰閘門＋瀏覽器端渲染；拍板公開後改成：
//   1) 「使用說明」＝ API.md（唯一原稿）→ 建置期就渲染＋消毒成 APIDOC_HTML，這裡直接吐
//   2) 「互動式參考」＝ vendored Scalar（public/assets/vendor/scalar.js，CSP 'self'）讀 /openapi.json
// Scalar 3.6MB 走懶載入 — 點了分頁才插 <script>，看說明的人不用付這個流量。
import { html, pageShell, esc } from "../lib/site.js";
import { getChromeFor } from "../lib/chrome.js";
import { APIDOC_HTML } from "../lib/apidoc.js";
import type { RouteCtx } from "../types.js";

const DOC_CSS = `
  .doctabs{display:flex;gap:8px;margin-bottom:18px;flex-wrap:wrap;align-items:center}
  .doctab{border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:20px;padding:8px 18px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;transition:.15s}
  .doctab:hover{border-color:var(--line2)}
  .doctab.on{background:var(--accent);color:var(--accent-fg);border-color:var(--line2)}
  .doctabs a{margin-left:auto;font-size:12.5px;color:var(--muted)}
  #scalarWrap{border:1px solid var(--line);border-radius:12px;overflow:hidden;background:#fff}
  .docstate{color:var(--muted);font-size:13px;padding:8px 0}
`;

const DOC_JS = `
(function(){
  "use strict";
  var prose=document.getElementById("docProse"),wrap=document.getElementById("scalarWrap"),
      state=document.getElementById("refState"),loaded=false;
  function show(ref){
    document.getElementById("tabDoc").classList.toggle("on",!ref);
    document.getElementById("tabRef").classList.toggle("on",ref);
    prose.hidden=ref; wrap.hidden=!ref;
    if(ref&&!loaded){
      loaded=true;
      state.hidden=false;
      var s=document.createElement("script");
      s.src="/assets/vendor/scalar.js";           /* CSP script-src 'self' 放行同源檔案 */
      s.onload=function(){ state.hidden=true; };
      s.onerror=function(){ state.textContent="互動式參考載入失敗 — 規格本體在 /openapi.json"; };
      document.body.appendChild(s);
    }
  }
  document.getElementById("tabDoc").addEventListener("click",function(){show(false);});
  document.getElementById("tabRef").addEventListener("click",function(){show(true);});
})();
`;

export async function onRequestGet({ request, env }: RouteCtx): Promise<Response> {
  const { chrome } = await getChromeFor(env, request); // 選單依身分過濾（VPN 隱形）
  // 渲染與消毒都在建置期做完了（tools/build-apidoc.mjs）— 這裡零運算，免費方案的 10ms CPU 省著用
  const docHtml = APIDOC_HTML;
  const body =
    "<style>" +
    DOC_CSS +
    "</style>\n" +
    '<div class="doctabs">\n' +
    '  <button id="tabDoc" class="doctab on" type="button">使用說明</button>\n' +
    '  <button id="tabRef" class="doctab" type="button">互動式參考（OpenAPI）</button>\n' +
    '  <a href="/openapi.json">openapi.json ↗</a>\n' +
    "</div>\n" +
    '<article class="art"><div id="docProse" class="prose">' +
    docHtml +
    "</div></article>\n" +
    '<div id="refState" class="docstate" hidden>互動式參考載入中…（約 1MB，只載一次）</div>\n' +
    '<div id="scalarWrap" hidden>\n' +
    // Scalar standalone 的掛載點：讀 data-url 指到的規格（同源，CSP connect-src 'self' 放行）。
    // 這顆 <script> 沒有 nonce、不會執行 — Scalar 只是用它當 DOM 錨點與設定載體。
    '  <script id="api-reference" data-url="' +
    esc("/openapi.json") +
    '"></script>\n' +
    "</div>\n" +
    "<script data-nonce>" +
    DOC_JS +
    "</script>";

  return html(
    pageShell({
      title: "API 文件",
      desc: "uaip.cc.cd 的 API 使用說明與 OpenAPI 互動式參考。",
      noindex: true,
      chrome: chrome,
      activePath: "/api-docs",
      h1: "API 文件",
      body: body
    })
  );
}
