// playwright.config.ts — E2E（v2.0.0 Phase M）。
// webServer 兩顆：mock 上游（tools/mock-upstream.mjs，OpenAI 相容 SSE 含 usage 尾包）
// ＋ wrangler dev（獨立狀態目錄 .wrangler/e2e-state — seed:e2e 每次先清乾淨再種）。
// 登入走 localhost 限定的 dev 登入表單（正式站不存在這條路）。
// 共用同一顆本機 D1 → workers:1 串行跑，測試間不互踩。
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://localhost:8787",
    trace: "retain-on-failure"
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: [
    {
      command: "node tools/mock-upstream.mjs",
      url: "http://127.0.0.1:8788/health",
      reuseExistingServer: !process.env.CI,
      timeout: 30_000
    },
    {
      command:
        // DEV_UNSAFE_ADMIN:1 —— E2E 走 /auth/login 的測試登入表單，而那條路 2026-07-22 起
        // 改由明示旗標開啟（原本看 Host 是不是 localhost，見 lib/auth.ts isDevEnv）。
        // 寫在這裡而不是靠 .dev.vars：.dev.vars 在 .gitignore 裡，CI 上不存在。
        "npm run seed:e2e && npx wrangler dev --port 8787 --persist-to .wrangler/e2e-state --var ADMIN_EMAILS:admin@example.com --var DEV_UNSAFE_ADMIN:1",
      url: "http://localhost:8787/api/health",
      reuseExistingServer: false, // 一定要吃剛清好的 e2e 狀態，不重用舊伺服器
      timeout: 180_000
    }
  ]
});
