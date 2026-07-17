// tools/seed-e2e.mjs — E2E 環境佈置（v2.0.0 Phase M）。
// E2E 用**獨立的** wrangler 狀態目錄（.wrangler/e2e-state，--persist-to）：
// 每次先整個刪掉（D1＋DO 限流計數都歸零 → demo 429 測試可重複跑），再套 migrations、塞種子。
// 不會碰開發者平常 npm run dev 的本機資料（.wrangler/state）。
import { execFileSync } from "node:child_process";
import { writeFileSync, rmSync } from "node:fs";

const STATE = ".wrangler/e2e-state";
// Windows 上殘留的 workerd 可能還握著檔案 → 給幾次重試（真的鎖死會拋 EPERM，提示殺進程）
rmSync(new URL("../" + STATE, import.meta.url), {
  recursive: true,
  force: true,
  maxRetries: 10,
  retryDelay: 300
});

const run = (args) => execFileSync("npx", args, { stdio: "inherit", shell: process.platform === "win32" });

run(["wrangler", "d1", "migrations", "apply", "ipua-logs", "--local", "--persist-to", STATE]);

const now = new Date().toISOString();
const sql = `
INSERT OR IGNORE INTO relay_channels (slug,name,kind,base_url,api_key,models,enabled,created_at)
VALUES ('mock','E2E mock 渠道','openai','http://127.0.0.1:8788','sk-e2e-mock','mock-model','1','${now}');
`;
const tmp = new URL("./.seed-e2e.tmp.sql", import.meta.url);
writeFileSync(tmp, sql);
try {
  run([
    "wrangler",
    "d1",
    "execute",
    "ipua-logs",
    "--local",
    "--persist-to",
    STATE,
    "--file",
    "tools/.seed-e2e.tmp.sql"
  ]);
} finally {
  rmSync(tmp, { force: true });
}
console.log("E2E 種子完成：乾淨狀態目錄 " + STATE + "、mock 渠道（→127.0.0.1:8788）。");
