// v2 Phase B 整合驗證：文章夾帶 XSS payload → SSR 頁與 ?html=1 API 都放不出去，
// 且 CSP nonce 只蓋外殼標記（data-nonce）的 script — 內容層 script 拿不到 nonce。
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { onRequestGet as newsPage } from "../../functions/news/[id].js";
import { onRequestGet as articleApi } from "../../functions/api/articles/[id].js";
import { makeCtx, ORIGIN } from "../helpers.js";

async function seedArticle(body_md) {
  const now = new Date().toISOString();
  const r = await env.DB.prepare(
    "INSERT INTO articles (category,title,summary,cover,body_md,status,views,created_at,updated_at,published_at) " +
    "VALUES ('news','XSS 測試','','',?1,'published',0,?2,?2,?2)"
  ).bind(body_md, now).run();
  return r.meta.last_row_id;
}

const PAYLOAD = "哈囉\n\n<script>window.__pwned=1</script>\n\n" +
  '<img src=x onerror="window.__pwned=2">\n\n' +
  '<a href="javascript:alert(1)">點我</a>\n\n正常段落';

describe("stored-XSS 防線（消毒＋nonce 標記制）", () => {
  it("SSR 文章頁：payload 全滅、外殼 script 才有 nonce", async () => {
    const id = await seedArticle(PAYLOAD);
    const r = await newsPage(makeCtx({ url: ORIGIN + "/news/" + id, params: { id: String(id) } }));
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(text).not.toContain("__pwned");
    expect(text).not.toContain("onerror");
    expect(text).not.toContain('href="javascript:');
    // 每一顆「可執行」的 script 都必須帶本回應的 nonce（JSON-LD 是資料塊、不用蓋）
    const nonce = r.headers.get("content-security-policy").match(/'nonce-([^']+)'/)[1];
    const scripts = text.match(/<script[^>]*>/g) || [];
    const exec = scripts.filter(function (s) { return s.indexOf("application/ld+json") < 0; });
    expect(exec.length).toBeGreaterThan(0);
    exec.forEach(function (s) { expect(s).toContain('nonce="' + nonce + '"'); });
    // 消毒不誤傷正常內容
    expect(text).toContain("正常段落");
    expect(text).toContain("點我");
  });

  it("?html=1 API：body_html 走同一套消毒、body_md 原稿不動", async () => {
    const id = await seedArticle(PAYLOAD);
    const r = await articleApi(makeCtx({
      url: ORIGIN + "/api/articles/" + id + "?html=1", params: { id: String(id) }
    }));
    const j = await r.json();
    expect(j.row.body_html).not.toContain("<script");
    expect(j.row.body_html).not.toContain("onerror");
    expect(j.row.body_md).toContain("<script");   // 編輯用原稿保持原樣
  });
});
