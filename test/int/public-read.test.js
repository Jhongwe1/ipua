// 公開讀取端點：feed / sitemap / img / health / whoami / menu / articles / pages。
// 這些是「不需登入就該通」的面，遷移後要維持同樣的 content-type 與內容形狀。
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { onRequestGet as feed } from "../../functions/feed.js";
import { onRequestGet as sitemap } from "../../functions/sitemap.js";
import { onRequestGet as img } from "../../functions/img/[id].js";
import { onRequestGet as health } from "../../functions/api/health.js";
import { onRequestGet as whoami } from "../../functions/api/whoami.js";
import { onRequestGet as menu } from "../../functions/api/menu.js";
import { onRequestGet as articleApi } from "../../functions/api/articles/[id].js";
import { onRequestGet as pageApi } from "../../functions/api/pages/[slug].js";
import { makeCtx, ORIGIN } from "../helpers.js";

async function pubArticle(over) {
  const now = new Date().toISOString();
  const o = Object.assign({ category: "news", title: "文", summary: "要", body_md: "內文", status: "published" }, over || {});
  const r = await env.DB.prepare(
    "INSERT INTO articles (category,title,summary,cover,body_md,status,views,created_at,updated_at,published_at) " +
    "VALUES (?1,?2,?3,'',?4,?5,0,?6,?6,?6)"
  ).bind(o.category, o.title, o.summary, o.body_md, o.status, now).run();
  return r.meta.last_row_id;
}

describe("/feed（RSS）", () => {
  it("回 rss+xml、含頻道與已發佈文章連結（絕對網址走 SITE_ORIGIN）", async () => {
    const id = await pubArticle({ title: "RSS 測試文" });
    const r = await feed(makeCtx({ url: ORIGIN + "/feed" }));
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("application/rss+xml");
    const xml = await r.text();
    expect(xml).toContain("<rss");
    expect(xml).toContain("RSS 測試文");
    expect(xml).toContain("https://uaip.cc.cd/news/" + id);
  });
  it("草稿不出現在 feed", async () => {
    await pubArticle({ title: "秘密草稿", status: "draft" });
    const xml = await (await feed(makeCtx({ url: ORIGIN + "/feed" }))).text();
    expect(xml).not.toContain("秘密草稿");
  });
});

describe("/sitemap", () => {
  it("回 xml、含固定頁與已發佈文章、頁面（絕對網址）", async () => {
    const id = await pubArticle({ title: "地圖文" });
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO pages (slug,title,summary,body_md,status,created_at,updated_at) VALUES ('sm','x','','y','published',?1,?1)"
    ).bind(now).run();
    const r = await sitemap(makeCtx({ url: ORIGIN + "/sitemap" }));
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("xml");
    const xml = await r.text();
    expect(xml).toContain("<urlset");
    expect(xml).toContain("https://uaip.cc.cd/news/" + id);
    expect(xml).toContain("https://uaip.cc.cd/p/sm");
    expect(xml).toContain("https://uaip.cc.cd/ip");
  });
});

describe("/img/<id>", () => {
  it("存在的圖片：回 bytes＋immutable 快取＋nosniff", async () => {
    const data = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);   // PNG 前 8 bytes
    const ins = await env.DB.prepare(
      "INSERT INTO media (mime,bytes,data,created_at) VALUES ('image/png',?1,?2,?3)"
    ).bind(data.length, data, new Date().toISOString()).run();
    const id = ins.meta.last_row_id;
    const r = await img(makeCtx({ url: ORIGIN + "/img/" + id, params: { id: String(id) } }));
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/png");
    expect(r.headers.get("cache-control")).toContain("immutable");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await r.arrayBuffer())[1]).toBe(80);
  });
  it("不存在／壞 id：404", async () => {
    expect((await img(makeCtx({ url: ORIGIN + "/img/999999", params: { id: "999999" } }))).status).toBe(404);
    expect((await img(makeCtx({ url: ORIGIN + "/img/abc", params: { id: "abc" } }))).status).toBe(404);
  });
});

describe("/api/health", () => {
  it("回 ok/version/db=true", async () => {
    const r = await health(makeCtx({ url: ORIGIN + "/api/health" }));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.db).toBe(true);
    expect(typeof j.version).toBe("string");
  });
});

describe("/api/whoami", () => {
  it("回請求端資訊、CORS 開放、no-store", async () => {
    const r = await whoami(makeCtx({
      url: ORIGIN + "/api/whoami",
      init: { headers: { "user-agent": "smoke-ua", "accept-language": "zh-TW" } }
    }));
    expect(r.status).toBe(200);
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
    expect(r.headers.get("cache-control")).toBe("no-store");
    const j = await r.json();
    expect(j.ua).toBe("smoke-ua");
    expect(j.lang).toBe("zh-TW");
    expect("latitude" in j).toBe(true);
  });
});

describe("/api/menu", () => {
  it("空表回內建預設 custom:false", async () => {
    const j = await (await menu(makeCtx({ url: ORIGIN + "/api/menu" }))).json();
    expect(j.custom).toBe(false);
    expect(j.items.some((i) => i.url === "/playground")).toBe(true);
  });
  it("有自訂列回 custom:true", async () => {
    await env.DB.prepare("INSERT INTO menu (pos,kind,label,label_en,url) VALUES (0,'link','自訂','Custom','/x')").run();
    const j = await (await menu(makeCtx({ url: ORIGIN + "/api/menu" }))).json();
    expect(j.custom).toBe(true);
    expect(j.items[0].url).toBe("/x");
  });
});

describe("/api/articles/<id> 與 /api/pages/<slug>（公開讀）", () => {
  it("已發佈文章回 row；?html=1 附消毒後 body_html", async () => {
    const id = await pubArticle({ title: "讀文", body_md: "**粗**\n\n<script>x</script>" });
    let j = await (await articleApi(makeCtx({ url: ORIGIN + "/api/articles/" + id, params: { id: String(id) } }))).json();
    expect(j.row.title).toBe("讀文");
    expect("body_html" in j.row).toBe(false);                  // 不帶 ?html 不轉
    j = await (await articleApi(makeCtx({ url: ORIGIN + "/api/articles/" + id + "?html=1", params: { id: String(id) } }))).json();
    expect(j.row.body_html).toContain("<strong>");
    expect(j.row.body_html).not.toContain("<script");          // 消毒過
  });
  it("草稿文章：404", async () => {
    const id = await pubArticle({ title: "草稿讀", status: "draft" });
    expect((await articleApi(makeCtx({ url: ORIGIN + "/api/articles/" + id, params: { id: String(id) } }))).status).toBe(404);
  });
  it("壞 slug：400；不存在頁面：404", async () => {
    expect((await pageApi(makeCtx({ url: ORIGIN + "/api/pages/BAD_SLUG", params: { slug: "BAD_SLUG" } }))).status).toBe(400);
    expect((await pageApi(makeCtx({ url: ORIGIN + "/api/pages/ghost", params: { slug: "ghost" } }))).status).toBe(404);
  });
});
