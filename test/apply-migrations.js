// test/apply-migrations.js — vitest setup：把 migrations/ 全部套進測試用 D1。
// TEST_MIGRATIONS 由 vitest.config.mjs 的 readD1Migrations 塞進來。
import { applyD1Migrations, env } from "cloudflare:test";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
