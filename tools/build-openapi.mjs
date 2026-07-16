// tools/build-openapi.mjs — 把 docs/openapi.yaml（唯一原稿）轉成 src/lib/openapi.ts，
// 供 GET /openapi.json 與 /api-docs 的互動式參考使用。
// 用法：node tools/build-openapi.mjs（npm run openapi；deploy 前自動跑）。
// yaml 套件只是 devDependency — 執行期 worker 拿到的是編譯好的 JSON 模組，維持零執行期依賴。
import { readFileSync, writeFileSync } from "node:fs";
import { parse } from "yaml";

const yamlUrl = new URL("../docs/openapi.yaml", import.meta.url);
const outUrl = new URL("../src/lib/openapi.ts", import.meta.url);

const spec = parse(readFileSync(yamlUrl, "utf8"));
if (!spec || !spec.openapi || !spec.paths) {
  console.error("docs/openapi.yaml 解析失敗或缺 openapi/paths 欄位");
  process.exit(1);
}

const out =
  "// src/lib/openapi.ts — ⚠ 自動產生，不要手改！原稿是 docs/openapi.yaml。\n" +
  "// 改規格流程：編輯 docs/openapi.yaml → npm run openapi → 部署。\n" +
  "// 規格形狀由 OpenAPI 定義，這裡只是載體 — 用寬鬆的 Record 型別。\n" +
  "export const OPENAPI: Record<string, any> = " +
  JSON.stringify(spec) +
  ";\n";

writeFileSync(outUrl, out);
console.log(
  "已產生 src/lib/openapi.ts（" + out.length + " 字元，" + Object.keys(spec.paths).length + " 條 path）"
);
