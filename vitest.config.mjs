// vitest.config.mjs — 測試跑在 workerd 裡（@cloudflare/vitest-pool-workers），
// 跟正式環境同一顆 runtime：D1、crypto.subtle、TransformStream 行為完全一致。
//
// miniflare 選項在這裡手動配（不吃 wrangler.toml，測試綁定獨立控制、不跟部署設定連動）：
// D1 綁定 DB ＋ 把 migrations/ 內容塞進 TEST_MIGRATIONS，
// 由 test/apply-migrations.ts（setupFiles）在每個測試檔開跑前套用 — schema 唯一來源是 migrations/。
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations(path.join(here, "migrations"));
  return {
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
      poolOptions: {
        workers: {
          // 測試共用一個 worker（D1 也是同一顆），isolatedStorage 讓每個測試自動回滾
          singleWorker: true,
          isolatedStorage: true,
          // DO 測試需要 main：RATE_LIMITER 綁定的類別從這個進入點的匯出找（Phase H）
          main: "./src/index.ts",
          miniflare: {
            compatibilityDate: "2026-07-01",
            d1Databases: ["DB"],
            r2Buckets: ["BACKUPS"], // Phase I 備份測試用（記憶體模擬）
            durableObjects: {
              RATE_LIMITER: { className: "RateLimiter", useSQLite: true }
            },
            bindings: {
              TEST_MIGRATIONS: migrations,
              // 正式環境由 wrangler.toml [vars]／secrets 提供；測試在這裡注入對應值
              SITE_ORIGIN: "https://uaip.cc.cd",
              ADMIN_EMAILS: "admin@example.com"
            }
          }
        }
      }
    }
  };
});
