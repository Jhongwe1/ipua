// tools/check-csp.mjs — 靜態 CSP 防漂移檢查（CI 與發佈清單都跑）。
// 原理：public/index.html 的 inline <script> 內容 → sha256 → 必須出現在 public/_headers
// 的 Content-Security-Policy 裡；反過來 _headers 裡的 sha256 也必須對得上某個 inline script。
// 改了 index.html 的 inline script 卻忘了更新 _headers → 這裡紅燈（上線前就抓到，不會白屏）。
//
// 用法：node tools/check-csp.mjs           檢查（不一致 exit 1）
//       node tools/check-csp.mjs --print   印出正確的 script-src 片段（貼回 _headers 用）
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const htmlPath = new URL("../public/index.html", import.meta.url);
const headersPath = new URL("../public/_headers", import.meta.url);
const html = readFileSync(htmlPath, "utf8");
const headersTxt = readFileSync(headersPath, "utf8");

// 抓所有「沒有 src 屬性」的 <script> 區塊，對內容原文（含換行）取 sha256 base64
const hashes = [];
const re = /<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi;
let m;
while ((m = re.exec(html))) {
  if (/\bsrc\s*=/i.test(m[1] || "")) continue;
  hashes.push("'sha256-" + createHash("sha256").update(m[2], "utf8").digest("base64") + "'");
}

if (process.argv.includes("--print")) {
  console.log("script-src 'self' " + hashes.join(" "));
  process.exit(0);
}

let ok = true;
for (const h of hashes) {
  if (!headersTxt.includes(h)) { console.error("✗ public/_headers 缺少：" + h); ok = false; }
}
for (const h of headersTxt.match(/'sha256-[A-Za-z0-9+/=]+'/g) || []) {
  if (!hashes.includes(h)) { console.error("✗ public/_headers 有對不上任何 inline script 的 hash：" + h); ok = false; }
}
if (!headersTxt.includes("Content-Security-Policy")) {
  console.error("✗ public/_headers 沒有 Content-Security-Policy 行");
  ok = false;
}
if (!ok) {
  console.error("→ 跑 node tools/check-csp.mjs --print 拿正確的 script-src，更新 public/_headers 後再試。");
  process.exit(1);
}
console.log("✓ CSP hash 一致（" + hashes.length + " 個 inline script）");
