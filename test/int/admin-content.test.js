// 站長內容寫入 API：文章 CRUD、頁面 CRUD、選單整包覆蓋。
// 驗證授權閘門（無金鑰→401）、輸入清洗、audit 寫入、published_at 穩定性。
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { onRequestGet as artList, onRequestPost as artCreate } from "../../functions/api/admin/articles/index.js";
import { onRequestPut as artUpdate, onRequestDelete as artDelete } from "../../functions/api/admin/articles/[id].js";
import { onRequestPost as pageCreate } from "../../functions/api/admin/pages/index.js";
import { onRequestPut as pageUpdate, onRequestDelete as pageDelete } from "../../functions/api/admin/pages/[key].js";
import { onRequestPut as menuPut } from "../../functions/api/admin/menu.js";
import { makeCtx, drainWaits, envWith, ORIGIN } from "../helpers.js";

const TOK = "admintok";
// 帶管理金鑰的 ctx（drainWaits 讓 audit 背景寫入跑完）
function ctx(path, method, body, params) {
  return makeCtx({
    url: ORIGIN + path,
    init: {
      method,
      headers: { authorization: "Bearer " + TOK, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    },
    params: params || {},
    env: envWith({ LOGS_TOKEN: TOK })
  });
}
async function call(fn, path, method, body, params) {
  const c = ctx(path, method, body, params);
  const r = await fn(c);
  await drainWaits(c);
  return r;
}
// 無授權 ctx（沒帶金鑰，也沒 cookie）
function anon(path, method, body, params) {
  return makeCtx({
    url: ORIGIN + path,
    init: { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined },
    params: params || {}, env: envWith({ LOGS_TOKEN: TOK })
  });
}
const lastAudit = () => env.DB.prepare("SELECT action,target FROM audit_log ORDER BY id DESC LIMIT 1").first();

describe("文章 CRUD", () => {
  it("POST 新增 → GET 列表看得到 → audit 記 create", async () => {
    const r = await call(artCreate, "/api/admin/articles", "POST",
      { category: "news", status: "published", title: "整合建立", summary: "s", body_md: "b" });
    expect(r.status).toBe(200);
    const { id } = await r.json();
    expect(id).toBeGreaterThan(0);
    const list = await (await call(artList, "/api/admin/articles", "GET")).json();
    expect(list.rows.some((x) => x.id === id)).toBe(true);
    expect((await lastAudit()).action).toBe("articles.create");
  });

  it("PUT 更新：published_at 首次發佈才寫、之後不變", async () => {
    const created = await (await call(artCreate, "/api/admin/articles", "POST",
      { status: "published", title: "原標題" })).json();
    const row1 = await env.DB.prepare("SELECT published_at FROM articles WHERE id=?1").bind(created.id).first();
    expect(row1.published_at).toBeTruthy();
    await call(artUpdate, "/api/admin/articles/" + created.id, "PUT",
      { status: "draft", title: "改成草稿" }, { id: String(created.id) });
    const row2 = await env.DB.prepare("SELECT published_at,title,status FROM articles WHERE id=?1").bind(created.id).first();
    expect(row2.title).toBe("改成草稿");
    expect(row2.status).toBe("draft");
    expect(row2.published_at).toBe(row1.published_at);           // 首次發佈時間保留
  });

  it("空標題 → 400；不存在 id 更新 → 404", async () => {
    expect((await call(artCreate, "/api/admin/articles", "POST", { title: "  " })).status).toBe(400);
    expect((await call(artUpdate, "/api/admin/articles/999999", "PUT", { title: "x" }, { id: "999999" })).status).toBe(404);
  });

  it("DELETE 刪除 → 查不到 → audit 記 delete", async () => {
    const c = await (await call(artCreate, "/api/admin/articles", "POST", { title: "待刪" })).json();
    const r = await call(artDelete, "/api/admin/articles/" + c.id, "DELETE", undefined, { id: String(c.id) });
    expect(r.status).toBe(200);
    expect(await env.DB.prepare("SELECT id FROM articles WHERE id=?1").bind(c.id).first()).toBeNull();
    expect((await lastAudit()).action).toBe("articles.delete");
  });

  it("無授權：POST/PUT/DELETE 全 401", async () => {
    expect((await artCreate(anon("/api/admin/articles", "POST", { title: "x" }))).status).toBe(401);
    expect((await artUpdate(anon("/api/admin/articles/1", "PUT", { title: "x" }, { id: "1" }))).status).toBe(401);
    expect((await artDelete(anon("/api/admin/articles/1", "DELETE", undefined, { id: "1" }))).status).toBe(401);
  });
});

describe("頁面 CRUD", () => {
  it("POST 新增 → slug 重複回 409", async () => {
    const r = await call(pageCreate, "/api/admin/pages", "POST", { slug: "dup", title: "頁一" });
    expect(r.status).toBe(200);
    expect((await r.json()).url).toBe("/p/dup");
    const r2 = await call(pageCreate, "/api/admin/pages", "POST", { slug: "dup", title: "頁二" });
    expect(r2.status).toBe(409);
  });

  it("壞 slug → 400", async () => {
    expect((await call(pageCreate, "/api/admin/pages", "POST", { slug: "-bad-", title: "x" })).status).toBe(400);
    expect((await call(pageCreate, "/api/admin/pages", "POST", { slug: "OK", title: "" })).status).toBe(400);
  });

  it("PUT 用 slug 找、可搬家；DELETE 移除", async () => {
    await call(pageCreate, "/api/admin/pages", "POST", { slug: "movable", title: "搬家前" });
    const put = await call(pageUpdate, "/api/admin/pages/movable", "PUT",
      { slug: "moved", title: "搬家後", status: "published" }, { key: "movable" });
    expect(put.status).toBe(200);
    expect(await env.DB.prepare("SELECT title FROM pages WHERE slug='moved'").first()).toBeTruthy();
    const del = await call(pageDelete, "/api/admin/pages/moved", "DELETE", undefined, { key: "moved" });
    expect(del.status).toBe(200);
    expect(await env.DB.prepare("SELECT id FROM pages WHERE slug='moved'").first()).toBeNull();
  });

  it("無授權：401", async () => {
    expect((await pageCreate(anon("/api/admin/pages", "POST", { slug: "x", title: "y" }))).status).toBe(401);
  });
});

describe("選單整包覆蓋", () => {
  it("PUT items 覆蓋 → /api/menu 反映；空陣列＝還原預設", async () => {
    const r = await call(menuPut, "/api/admin/menu", "PUT", {
      items: [{ kind: "section", label: "區" }, { kind: "link", label: "首頁", url: "/" }]
    });
    expect(r.status).toBe(200);
    expect((await r.json()).count).toBe(2);
    const rows = await env.DB.prepare("SELECT label,url FROM menu ORDER BY pos").all();
    expect(rows.results.length).toBe(2);
    // 清空＝還原
    const back = await call(menuPut, "/api/admin/menu", "PUT", { items: [] });
    expect((await back.json()).custom).toBe(false);
    expect((await env.DB.prepare("SELECT COUNT(*) c FROM menu").first()).c).toBe(0);
  });

  it("link 網址非 / 或 http(s) → 400（擋 javascript:）", async () => {
    const r = await call(menuPut, "/api/admin/menu", "PUT",
      { items: [{ kind: "link", label: "壞", url: "javascript:alert(1)" }] });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe("bad-url");
  });

  it("缺 items 陣列 → 400；無授權 → 401", async () => {
    expect((await call(menuPut, "/api/admin/menu", "PUT", { nope: 1 })).status).toBe(400);
    expect((await menuPut(anon("/api/admin/menu", "PUT", { items: [] }))).status).toBe(401);
  });
});
