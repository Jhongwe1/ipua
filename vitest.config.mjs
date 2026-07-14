// vitest.config.mjs — 測試跑在 workerd 裡（@cloudflare/vitest-pool-workers），
// 跟正式環境同一顆 runtime：D1、crypto.subtle、TransformStream 行為完全一致。
//
// 注意：pool-workers 讀不了 Pages 版 wrangler.toml（pages_build_output_dir 會被拒收），
// 所以 miniflare 選項在這裡手動配：D1 綁定 DB ＋ 把 migrations/ 內容塞進 TEST_MIGRATIONS，
// 由 test/apply-migrations.js（setupFiles）在每個測試檔開跑前套用 — schema 唯一來源是 migrations/。
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations(path.join(here, "migrations"));
  return {
    test: {
      setupFiles: ["./test/apply-migrations.js"],
      poolOptions: {
        workers: {
          // 測試共用一個 worker（D1 也是同一顆），isolatedStorage 讓每個測試自動回滾
          singleWorker: true,
          isolatedStorage: true,
          miniflare: {
            compatibilityDate: "2026-07-01",
            d1Databases: ["DB"],
            bindings: { TEST_MIGRATIONS: migrations }
          }
        }
      }
    }
  };
});
