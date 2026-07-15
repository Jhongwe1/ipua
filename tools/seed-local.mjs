// tools/seed-local.mjs — 本機開發資料種子：塞一個站長、一個已批准會員、
// 一個 relay 渠道（假上游，聊天會 502 但頁面全部能看）。可重複執行（OR IGNORE）。
// 先跑 npm run migrate:local 建表，再跑 npm run seed。
import { execFileSync } from "node:child_process";
import { writeFileSync, rmSync } from "node:fs";

const now = new Date().toISOString();
const sql = `
INSERT OR IGNORE INTO users (google_sub,email,name,status,services,is_admin,vpn_token,created_at,last_login)
VALUES ('dev:admin@example.com','admin@example.com','站長（本機）','approved','',1,'uvtdevadmintoken2345','${now}','${now}');
INSERT OR IGNORE INTO users (google_sub,email,name,status,services,is_admin,vpn_token,created_at,last_login)
VALUES ('dev:member@example.com','member@example.com','測試會員','approved','relay,playground',0,'uvtdevmembertoken234','${now}','${now}');
INSERT OR IGNORE INTO relay_channels (slug,name,kind,base_url,api_key,models,enabled,created_at)
VALUES ('demo','本機示範渠道','openai','http://127.0.0.1:9','sk-dev-not-real','demo-model','1','${now}');
INSERT OR IGNORE INTO menu (pos,kind,label,label_en,url) VALUES (999,'link','（種子）關於','About (seed)','/p/about');
`;

const tmp = new URL("./.seed.tmp.sql", import.meta.url);
writeFileSync(tmp, sql);
try {
  execFileSync("npx", ["wrangler", "d1", "execute", "ipua-logs", "--local", "--file", "tools/.seed.tmp.sql"],
    { stdio: "inherit", shell: process.platform === "win32" });
} finally {
  rmSync(tmp, { force: true });
}
console.log("本機種子完成：站長 admin@example.com、會員 member@example.com、渠道 demo。");
