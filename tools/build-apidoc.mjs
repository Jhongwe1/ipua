// tools/build-apidoc.mjs — 把 API.md（唯一原稿）轉成 src/lib/apidoc.ts，供線上 /api-docs 頁使用。
// 用法：node tools/build-apidoc.mjs
// 什麼時候要跑：改了 API.md 之後、部署之前。（用 JSON.stringify 序列化，不會有跳脫問題）
//
// 產出兩個常數：
//   APIDOC      Markdown 原文 — /api/admin/apidoc 回傳的就是這個
//   APIDOC_HTML 已渲染＋已消毒的 HTML — /api-docs 直接吐出去
//
// 為什麼 HTML 要在這裡先算好（2026-07-21）：以前 /api-docs 每次請求都跑一次
// marked.parse ＋ sanitizeHtml，本機實測 4.19ms，而免費方案每次呼叫只有 10ms CPU。
// 文件是 repo 裡的靜態檔，每次請求算出來的結果都一模一樣 — 純浪費。
// 消毒仍然照跑（只是移到建置期），輸出與過去逐字相同，安全性沒有任何放寬。
import { readFileSync, writeFileSync } from "node:fs";
import { marked } from "../src/lib/vendor/marked.mjs";
import { sanitizeHtml } from "../src/lib/sanitize.ts";

const mdUrl = new URL("../API.md", import.meta.url);
const outUrl = new URL("../src/lib/apidoc.ts", import.meta.url);

let md = readFileSync(mdUrl, "utf8").replace(/\r\n/g, "\n");

// 拿掉開頭的「# 大標題」與「> 原稿說明」引言 — 線上 /api-docs 頁自己有頁面標題，
// 而「改完要跑 build」的說明只跟 repo 裡的人有關，跟線上讀者無關。
md = md.replace(/^# [^\n]*\n+/, "");
md = md.replace(/^(?:>[^\n]*\n)+\n?/, "");

// 跟文章／自訂頁同一條管線（marked 放行原始 HTML，一律過白名單）— 只是提前到建置期跑
const html = sanitizeHtml(marked.parse(md, { gfm: true, breaks: false, async: false }));

const out =
  "// src/lib/apidoc.ts — ⚠ 自動產生，不要手改！原稿是專案根目錄 API.md。\n" +
  "// 改文件流程：編輯 API.md → node tools/build-apidoc.mjs → npx wrangler deploy\n" +
  "export const APIDOC: string = " +
  JSON.stringify(md) +
  ";\n" +
  "// 已渲染＋已消毒的 HTML — /api-docs 直接吐出，執行期不再跑 marked／sanitize。\n" +
  "export const APIDOC_HTML: string = " +
  JSON.stringify(html) +
  ";\n";

writeFileSync(outUrl, out);
console.log(
  "已產生 src/lib/apidoc.ts（" +
    out.length +
    " 字元），原稿 API.md（" +
    md.length +
    " 字元）→ HTML（" +
    html.length +
    " 字元，建置期已消毒）"
);
