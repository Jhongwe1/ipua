// test/helpers.js — 測試共用工具。
// 測試「直接 import Pages Function 的 handler」（例：import { onRequest } from
// "../../functions/relay/[[path]].js"），再用 makeCtx() 手造 EventContext 呼叫 —
// 不經 wrangler build，跑得快、又能對 D1／回應做細部斷言。
import { env as testEnv } from "cloudflare:test";
import { sha256hex } from "../lib/auth.js";

export const ORIGIN = "https://uaip.cc.cd";

/* ===== EventContext 手造 =====
   makeCtx({ url, init, request, env, params, next })
   - waitUntil 收集所有背景 promise 到 ctx._waits；測試用 drainWaits(ctx) 等它們跑完
   - env 預設是 cloudflare:test 的 env（有 D1）；可用 opts.env 覆寫或用 envWith() 加鍵 */
export function makeCtx(opts) {
  opts = opts || {};
  const request = opts.request instanceof Request
    ? opts.request
    : new Request(opts.url || ORIGIN + "/", opts.init || {});
  const waits = [];
  return {
    request: request,
    env: opts.env || testEnv,
    params: opts.params || {},
    data: {},
    waitUntil: function (p) { waits.push(Promise.resolve(p)); },
    passThroughOnException: function () {},
    next: opts.next || function () { return Promise.resolve(new Response("next")); },
    _waits: waits
  };
}

// 等 waitUntil 收集到的背景工作全部結束（背景工作裡又掛新 waitUntil 也會等到）
export async function drainWaits(ctx) {
  let done = 0;
  while (ctx._waits.length > done) {
    const batch = ctx._waits.slice(done);
    done = ctx._waits.length;
    await Promise.allSettled(batch);
  }
}

// 在測試 env 之上疊加／覆寫幾個鍵（例：envWith({ LOGS_TOKEN: "tok" })）
export function envWith(extra) {
  return Object.assign(Object.create(testEnv), extra || {});
}

/* ===== 資料佈置 ===== */

// 建會員：回傳 users 整列。預設待核准、無服務、無個人配額覆寫。
export async function seedUser(over) {
  const o = Object.assign({
    google_sub: "test:" + Math.random().toString(36).slice(2),
    email: "user" + Math.floor(Math.random() * 1e6) + "@example.com",
    name: "測試會員",
    status: "pending",
    services: "",
    is_admin: 0,
    api_key_hash: "",
    api_key_hint: "",
    vpn_token: "",
    quota_relay_day: null,
    quota_pg_day: null,
    rl_per_min: null
  }, over || {});
  const now = new Date().toISOString();
  const r = await testEnv.DB.prepare(
    "INSERT INTO users (google_sub,email,name,status,services,is_admin,api_key_hash,api_key_hint,vpn_token," +
    "quota_relay_day,quota_pg_day,rl_per_min,created_at,last_login) " +
    "VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?13)"
  ).bind(o.google_sub, o.email, o.name, o.status, o.services, o.is_admin,
         o.api_key_hash, o.api_key_hint, o.vpn_token,
         o.quota_relay_day, o.quota_pg_day, o.rl_per_min, now).run();
  return await testEnv.DB.prepare("SELECT * FROM users WHERE id=?1").bind(r.meta.last_row_id).first();
}

// 建站長（預設用 lib/auth.js 內建站長信箱，登入即管理員）
export function seedAdmin(over) {
  return seedUser(Object.assign({
    email: "zwwe1f@gmail.com", name: "站長", status: "approved", is_admin: 1
  }, over || {}));
}

// 幫既有會員配一把 uak- 金鑰：資料庫存雜湊、回傳明文（測試拿去打 relay）。
// 注意 userFromKey 的格式檢查是 uak- 後 16–64 個 a-z2-7 — 太短會直接 401。
export async function giveKey(user) {
  let rand = "";
  while (rand.length < 20) rand += Math.random().toString(36).slice(2).replace(/[^a-z2-7]/g, "");
  const key = "uak-" + rand.slice(0, 20);
  await testEnv.DB.prepare("UPDATE users SET api_key_hash=?1, api_key_hint=?2 WHERE id=?3")
    .bind(await sha256hex(key), key.slice(0, 8) + "…" + key.slice(-4), user.id).run();
  return key;
}

// 建 relay 渠道
export async function seedChannel(over) {
  const o = Object.assign({
    slug: "ch" + Math.floor(Math.random() * 1e6),
    name: "測試渠道",
    kind: "openai",
    base_url: "https://api.example.com",
    api_key: "sk-upstream-secret",
    models: "test-model",
    enabled: 1
  }, over || {});
  const r = await testEnv.DB.prepare(
    "INSERT INTO relay_channels (slug,name,kind,base_url,api_key,models,enabled,created_at) " +
    "VALUES (?1,?2,?3,?4,?5,?6,?7,?8)"
  ).bind(o.slug, o.name, o.kind, o.base_url, o.api_key, o.models, o.enabled, new Date().toISOString()).run();
  return await testEnv.DB.prepare("SELECT * FROM relay_channels WHERE id=?1").bind(r.meta.last_row_id).first();
}

// 讀 SSE Response 的全部內容（回文字；測試自己 parse data: 行）
export async function readAll(resp) {
  return await new Response(resp.body).text();
}

// 把 SSE 文字拆成 data: JSON 陣列
export function sseEvents(text) {
  return text.split("\n").filter(function (l) { return l.indexOf("data: ") === 0; })
    .map(function (l) { return JSON.parse(l.slice(6)); });
}
