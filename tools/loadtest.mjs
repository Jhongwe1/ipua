// tools/loadtest.mjs — DO 原子限流器的「真 HTTP 併發」驗證（ADR-0007）。
//
// 用法：
//   node tools/loadtest.mjs                # 自己起 mock 上游＋wrangler dev，跑完自動收掉
//   node tools/loadtest.mjs --external     # 用已經在跑的 http://localhost:8799（自己先 seed）
//   node tools/loadtest.mjs --burst 200 --limit 30 --lat 2000
//
// 為什麼需要它：現有證據是 test/unit/rate-limiter.test.ts 的 in-process Promise.all 30 發。
// 那是好測試，但它跑在**同一個 isolate、同一顆 DO stub** 上 —— 證明的是「方法體內沒有 await
// 所以不會交錯」，不是「200 條真的 HTTP 連線同時打進來時，DO 仍然恰好放行 limit 個」。
// 中間隔著 router、adminOk/userFromKey、D1 查詢、DO RPC 序列化 —— 那些都是併發下可能出事的地方。
//
// ⚠ 跑之前先在紙上寫下你預測的數字（ADR-0007 的考卷）：
//     1. 200 條併發、每分鐘上限 30 → 幾個 200？幾個 429？
//     2. 被擋的請求會不會吃掉額度？（提示：DO 的 check() 只有放行才 +1）
//     3. gateway overhead 的 p99 會比 p50 高多少倍？為什麼？
//   預測對了代表你真的懂 DO 的單執行緒語意；預測錯的那一項，就是你最該補的一課。
import { execFileSync, spawn } from "node:child_process";
import { writeFileSync, rmSync } from "node:fs";

const arg = (name, dft) => {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 ? process.argv[i + 1] : dft;
};
const BURST = parseInt(arg("burst", "200"), 10); // 同時打出去的請求數
const LIMIT = parseInt(arg("limit", "30"), 10); // 每分鐘上限（會寫進 settings.rl_per_min）
const LAT_N = parseInt(arg("lat", "2000"), 10); // 延遲取樣數（序列跑，避免互相排隊）
const EXTERNAL = process.argv.includes("--external");

const PORT = 8799; // 刻意避開 dev(8787) 與 e2e mock(8788)
const MOCK_PORT = 8790;
const STATE = ".wrangler/loadtest-state";
const BASE = "http://localhost:" + PORT;
// 兩把固定金鑰、兩個會員（uak- 後只能用 a-z2-7，沒有 0/1/8/9）。
// 為什麼是兩個帳號而不是「跑到一半改設定」：限流計數住在 DO 裡、設定住在 D1 裡，
// 而 wrangler dev 正握著同一個 --persist-to 目錄 —— 中途再開一個 wrangler d1 execute
// 去改 settings 會跟它搶 SQLite 鎖（實測直接讓 libuv 斷言失敗）。
// users.rl_per_min 本來就是「個人覆寫」欄位，一次種好兩種額度最乾淨。
const KEY_BURST = "uak-loadtestburst234567"; // rl_per_min = LIMIT（測限流）
const KEY_LAT = "uak-loadtestlatency2345"; // rl_per_min 極高（測延遲，不希望被擋）
const UPSTREAM_DELAY_MS = 25; // mock 上游的固定延遲 —— 扣掉它剩下的就是本 worker 的成本

const sh = process.platform === "win32";
const run = (args, opts) => execFileSync("npx", args, { stdio: "inherit", shell: sh, ...opts });

/* ===== 1) 佈置：獨立狀態目錄，每次從零開始 =====
   限流計數住在 DO 裡，不清乾淨的話第二次跑會直接全部 429。 */
async function seed() {
  try {
    rmSync(new URL("../" + STATE, import.meta.url), {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 300
    });
  } catch {
    // Windows：上一輪殘留的 workerd 還握著檔案，砍不掉。與其讓 rmSync 的 EPERM
    // 直接噴堆疊，不如講清楚要做什麼 —— 這是本機工具，使用者就是開發者自己。
    console.error("\n✗ 清不掉 " + STATE + "（多半是上一輪殘留的 workerd 還開著）");
    console.error("  Windows：  Get-Process workerd | Stop-Process -Force");
    console.error("  macOS/Linux： pkill -f workerd");
    console.error("  然後再跑一次。\n");
    process.exit(1);
  }
  run(["wrangler", "d1", "migrations", "apply", "ipua-logs", "--local", "--persist-to", STATE]);
  const now = new Date().toISOString();
  // api_key_hash 是金鑰的 sha256（lib/auth.ts userFromKey 就是這樣比對的）
  const sha = async (s) =>
    Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  const hBurst = await sha(KEY_BURST);
  const hLat = await sha(KEY_LAT);
  const sql = `
INSERT OR IGNORE INTO users (google_sub,email,name,status,services,is_admin,api_key_hash,api_key_hint,vpn_token,rl_per_min,quota_relay_day,created_at,last_login)
VALUES ('load:burst','burst@example.com','壓測會員（限流）','approved','relay,playground',0,'${hBurst}','uak-load…4567','uvtloadburst23456789',${LIMIT},1000000,'${now}','${now}');
INSERT OR IGNORE INTO users (google_sub,email,name,status,services,is_admin,api_key_hash,api_key_hint,vpn_token,rl_per_min,quota_relay_day,created_at,last_login)
VALUES ('load:lat','lat@example.com','壓測會員（延遲）','approved','relay,playground',0,'${hLat}','uak-load…2345','uvtloadlat2345678901',99999999,99999999,'${now}','${now}');
INSERT OR IGNORE INTO relay_channels (slug,name,kind,base_url,api_key,models,enabled,created_at)
VALUES ('mock','壓測 mock 渠道','openai','http://127.0.0.1:${MOCK_PORT}','sk-loadtest','mock-model',1,'${now}');
`;
  const tmp = new URL("./.loadtest.tmp.sql", import.meta.url);
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
      "tools/.loadtest.tmp.sql"
    ]);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/* ===== 2) 起服務 ===== */
const children = [];
function spawnBg(cmd, args, env) {
  const c = spawn(cmd, args, { shell: sh, stdio: "ignore", env: { ...process.env, ...env } });
  children.push(c);
  return c;
}
function cleanup() {
  for (const c of children) {
    try {
      c.kill();
    } catch {
      /* 已經自己死掉了就算了 —— 收尾不該因為收不掉而中斷後面的收尾 */
    }
  }
}
process.on("exit", cleanup);
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});

async function waitFor(url, ms = 120000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* 伺服器還沒起來，連不上是預期中的 —— 繼續等到逾時為止 */
    }
    if (Date.now() - t0 > ms) throw new Error("等不到 " + url + "（" + ms + "ms）");
    await new Promise((r) => setTimeout(r, 400));
  }
}

/* ===== 3) 量測 ===== */
const hit = (path, init) => fetch(BASE + path, init);
const authed = (key) => ({ headers: { authorization: "Bearer " + key, "content-type": "application/json" } });
const CHAT_BODY = JSON.stringify({ model: "mock-model", messages: [{ role: "user", content: "hi" }] });

function pct(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function burstTest() {
  console.log("\n── 測試 1：" + BURST + " 條真 HTTP 併發 × 每分鐘上限 " + LIMIT + " ──");
  // 全部一次丟出去，不等前一個回來 —— 這才是「真併發」，跟 in-process Promise.all 的差別在這
  const reqs = Array.from({ length: BURST }, () =>
    hit("/relay/mock/v1/chat/completions", {
      method: "POST",
      ...authed(KEY_BURST),
      body: CHAT_BODY
    }).then(
      (r) => r.status,
      () => 0
    )
  );
  const codes = await Promise.all(reqs);
  const tally = {};
  for (const c of codes) tally[c] = (tally[c] || 0) + 1;
  const ok = tally[200] || 0;
  const limited = tally[429] || 0;
  console.log("  回應碼分佈：", tally);
  console.log("  放行 " + ok + " / 擋下 " + limited + " / 預期放行 " + LIMIT);
  const pass = ok === LIMIT && ok + limited === BURST;
  console.log(
    pass
      ? "  ✓ 恰好 " + LIMIT + " 個通過 —— DO 的單執行緒語意在真併發下成立（永不超賣）"
      : "  ✗ 對不上：DO 應該恰好放行 " + LIMIT + " 個，其餘全 429"
  );
  return pass;
}

async function latencyTest() {
  console.log(
    "\n── 測試 2：gateway overhead（上游固定 " + UPSTREAM_DELAY_MS + "ms，扣掉就是本 worker 的成本）──"
  );
  // 換一個 rl_per_min 極高的會員（KEY_LAT），這一輪只量延遲不量限流
  const samples = [];
  for (let i = 0; i < LAT_N; i++) {
    const t0 = performance.now();
    const r = await hit("/relay/mock/v1/chat/completions", {
      method: "POST",
      ...authed(KEY_LAT),
      body: CHAT_BODY
    });
    await r.arrayBuffer(); // 一定要讀完 body，否則量到的是「標頭到手」不是整趟
    if (r.status === 200) samples.push(performance.now() - t0 - UPSTREAM_DELAY_MS);
    if (i % 500 === 499) process.stdout.write("    " + (i + 1) + "/" + LAT_N + "\r");
  }
  samples.sort((a, b) => a - b);
  const f = (n) => n.toFixed(2) + "ms";
  console.log("    取樣 " + samples.length + " 筆（扣除上游延遲後）        ");
  console.log(
    "      p50 " + f(pct(samples, 50)) + "   p95 " + f(pct(samples, 95)) + "   p99 " + f(pct(samples, 99))
  );
  console.log("      最快 " + f(samples[0]) + "   最慢 " + f(samples[samples.length - 1]));
  console.log("    ⚠ 這是**本機合成壓測**：wrangler dev 的 workerd 不等於邊緣節點，");
  console.log("      而 mock 上游在同一台機器上（沒有真實網路）。要看的是相對量級與分佈形狀。");
  return samples;
}

/* ===== main ===== */
if (!EXTERNAL) {
  console.log("佈置壓測環境（獨立狀態目錄 " + STATE + "）…");
  await seed();
  console.log("啟動 mock 上游（port " + MOCK_PORT + "，固定延遲 " + UPSTREAM_DELAY_MS + "ms）…");
  spawnBg("node", ["tools/mock-upstream.mjs"], {
    MOCK_PORT: String(MOCK_PORT),
    MOCK_DELAY_MS: String(UPSTREAM_DELAY_MS)
  });
  await waitFor("http://127.0.0.1:" + MOCK_PORT + "/health", 30000);
  console.log("啟動 wrangler dev（port " + PORT + "）…");
  spawnBg("npx", ["wrangler", "dev", "--port", String(PORT), "--persist-to", STATE]);
  await waitFor(BASE + "/api/health");
  console.log("就緒。");
} else {
  await waitFor(BASE + "/api/health", 10000);
}

const burstPass = await burstTest();
await latencyTest();
console.log("");
cleanup();
process.exit(burstPass ? 0 : 1);
