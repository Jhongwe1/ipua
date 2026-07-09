// tools/build-apidoc.mjs — 把 API.md（唯一原稿）轉成 lib/apidoc.js，供線上 /api-docs 頁使用。
// 用法：node tools/build-apidoc.mjs
// 什麼時候要跑：改了 API.md 之後、部署之前。（用 JSON.stringify 序列化，不會有跳脫問題）
import { readFileSync, writeFileSync } from "node:fs";

const mdUrl = new URL("../API.md", import.meta.url);
const outUrl = new URL("../lib/apidoc.js", import.meta.url);

let md = readFileSync(mdUrl, "utf8").replace(/\r\n/g, "\n");

// 拿掉開頭的「# 大標題」與「> 原稿說明」引言 — 線上 /api-docs 頁自己有頁面標題，
// 而「改完要跑 build」的說明只跟 repo 裡的人有關，跟線上讀者無關。
md = md.replace(/^# [^\n]*\n+/, "");
md = md.replace(/^(?:>[^\n]*\n)+\n?/, "");

const out =
  "// lib/apidoc.js — ⚠ 自動產生，不要手改！原稿是專案根目錄 API.md。\n" +
  "// 改文件流程：編輯 API.md → node tools/build-apidoc.mjs → npx wrangler pages deploy\n" +
  "export const APIDOC = " + JSON.stringify(md) + ";\n";

writeFileSync(outUrl, out);
console.log("已產生 lib/apidoc.js（" + out.length + " 字元），原稿 API.md（" + md.length + " 字元）");
