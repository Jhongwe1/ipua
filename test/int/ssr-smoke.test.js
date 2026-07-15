// 所有 SSR 頁面的冒煙測試：狀態碼、CSP nonce（走 html() 出口）、noindex 標記。
// 遷移到 Workers 後這些頁要一字不差地照常出，這層網先立在遷移之前。
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { onRequestGet as newsList } from "../../functions/news/index.js";
import { onRequestGet as articlesList } from "../../functions/articles/index.js";
import { onRequestGet as newsItem } from "../../functions/news/[id].js";
import { onRequestGet as customPage } from "../../functions/p/[slug].js";
import { onRequestGet as adminPage } from "../../functions/admin.js";
import { onRequestGet as logsPage } from "../../functions/logs.js";
import { onRequestGet as membersPage } from "../../functions/members.js";
import { onRequest as relayRoute } from "../../functions/relay/[[path]].js";
import { onRequestGet as playgroundPage } from "../../functions/playground.js";
import { makeCtx, seedAdmin, ORIGIN } from "../helpers.js";
import { createSession } from "../../lib/auth.js";

async function adminHeaders() {
  const adm = await seedAdmin();
  const s = await createSession(env, adm, new URL(ORIGIN + "/"));
  return { cookie: "ipua_sess=" + s.sid };
}

// 共用斷言：200＋text/html＋CSP nonce
async function expectPage(r) {
  expect(r.status).toBe(200);
  expect(r.headers.get("content-type")).toContain("text/html");
  expect(r.headers.get("content-security-policy")).toContain("nonce-");
  const text = await r.text();
  // 蓋到 nonce 的 script 一定帶本回應的 nonce（外殼至少一顆）
  const nonce = r.headers.get("content-security-policy").match(/'nonce-([^']+)'/)[1];
  expect(text).toContain('nonce="' + nonce + '"');
  return text;
}

describe("公開內容頁", () => {
  it("/news 列表：200＋nonce＋帶 canonical", async () => {
    const text = await expectPage(await newsList(makeCtx({ url: ORIGIN + "/news" })));
    expect(text).toContain('rel="canonical"');
    expect(text).toContain("https://uaip.cc.cd/news");           // 用 SITE_ORIGIN
  });
  it("/articles 列表：200＋nonce", async () => {
    await expectPage(await articlesList(makeCtx({ url: ORIGIN + "/articles" })));
  });
  it("空資料庫的列表頁顯示 empty，不掛掉", async () => {
    const text = await expectPage(await articlesList(makeCtx({ url: ORIGIN + "/articles" })));
    expect(text).toContain("empty.list");
  });
  it("/news/<id> 存在的文章：200＋og:title＋JSON-LD", async () => {
    const now = new Date().toISOString();
    const ins = await env.DB.prepare(
      "INSERT INTO articles (category,title,summary,cover,body_md,status,views,created_at,updated_at,published_at) " +
      "VALUES ('news','冒煙標題','摘要','','內文','published',0,?1,?1,?1)"
    ).bind(now).run();
    const id = ins.meta.last_row_id;
    const text = await expectPage(await newsItem(makeCtx({ url: ORIGIN + "/news/" + id, params: { id: String(id) } })));
    expect(text).toContain("冒煙標題");
    expect(text).toContain('property="og:title"');
    expect(text).toContain("application/ld+json");
  });
  it("/news/<id> 不存在：404＋noindex", async () => {
    const r = await newsItem(makeCtx({ url: ORIGIN + "/news/999999", params: { id: "999999" } }));
    expect(r.status).toBe(404);
    expect(await r.text()).toContain("noindex");
  });
  it("/p/<slug> 不存在：404＋noindex", async () => {
    const r = await customPage(makeCtx({ url: ORIGIN + "/p/nope", params: { slug: "nope" } }));
    expect(r.status).toBe(404);
    expect(await r.text()).toContain("noindex");
  });
  it("/p/<slug> 已發佈：200＋內容", async () => {
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO pages (slug,title,summary,body_md,status,created_at,updated_at) " +
      "VALUES ('smoke','冒煙頁','','頁面內文','published',?1,?1)"
    ).bind(now).run();
    const text = await expectPage(await customPage(makeCtx({ url: ORIGIN + "/p/smoke", params: { slug: "smoke" } })));
    expect(text).toContain("冒煙頁");
  });
});

describe("站長／會員頁（noindex）", () => {
  it("/admin：200＋noindex＋nonce", async () => {
    const text = await expectPage(await adminPage(makeCtx({ url: ORIGIN + "/admin", init: { headers: await adminHeaders() } })));
    expect(text).toContain("noindex");
  });
  it("/logs：200＋noindex", async () => {
    const text = await expectPage(await logsPage(makeCtx({ url: ORIGIN + "/logs", init: { headers: await adminHeaders() } })));
    expect(text).toContain("noindex");
  });
  it("/members：200＋noindex", async () => {
    const text = await expectPage(await membersPage(makeCtx({ url: ORIGIN + "/members", init: { headers: await adminHeaders() } })));
    expect(text).toContain("noindex");
  });
  it("/relay：匿名也 200（catch-all 零段落＝操作頁，頁內自帶登入閘門）＋nonce", async () => {
    await expectPage(await relayRoute(makeCtx({ url: ORIGIN + "/relay", params: { path: [] } })));
  });
  it("/playground：匿名也 200＋nonce", async () => {
    await expectPage(await playgroundPage(makeCtx({ url: ORIGIN + "/playground" })));
  });
});
