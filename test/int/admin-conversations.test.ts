// /api/admin/conversations（2026-07-20）：管理員看全站 Playground 對話。
// 重點：授權、新→舊排序、每列帶會員信箱、q／user_id 過濾、單則對話含全部訊息（舊→新）。
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { onRequestGet as convList } from "../../src/routes/api/admin/conversations/index.js";
import { onRequestGet as convGet } from "../../src/routes/api/admin/conversations/[id].js";
import { makeCtx, seedUser, envWith, ORIGIN } from "../helpers.js";

const TOK = "admintok";
const AUTH = { authorization: "Bearer " + TOK };
const E = () => envWith({ LOGS_TOKEN: TOK });

const listCtx = (qs?: string) =>
  makeCtx({ url: ORIGIN + "/api/admin/conversations" + (qs || ""), init: { headers: AUTH }, env: E() });
const getCtx = (id: number | string) =>
  makeCtx({
    url: ORIGIN + "/api/admin/conversations/" + id,
    init: { headers: AUTH },
    env: E(),
    params: { id: String(id) }
  });
const list = (qs?: string) => convList(listCtx(qs));
const one = (id: number | string) => convGet(getCtx(id));

// 建對話（updated_at 決定排序）＋幾則訊息
async function seedConv(userId: number, o: { title: string; updated: string; model?: string }) {
  const r = await env.DB.prepare(
    "INSERT INTO pg_conversations (user_id,title,channel,model,created_at,updated_at) VALUES (?1,?2,'ch',?3,?4,?4)"
  )
    .bind(userId, o.title, o.model || "test-model", o.updated)
    .run();
  return r.meta.last_row_id as number;
}
async function seedMsg(convId: number, role: string, content: string, at: string) {
  await env.DB.prepare(
    "INSERT INTO pg_messages (conv_id,role,content,model,created_at) VALUES (?1,?2,?3,'test-model',?4)"
  )
    .bind(convId, role, content, at)
    .run();
}

describe("/api/admin/conversations", () => {
  it("沒授權 401（列表與單則）", async () => {
    const noAuth = makeCtx({ url: ORIGIN + "/api/admin/conversations", env: E() });
    expect((await convList(noAuth)).status).toBe(401);
    const noAuth1 = makeCtx({
      url: ORIGIN + "/api/admin/conversations/1",
      env: E(),
      params: { id: "1" }
    });
    expect((await convGet(noAuth1)).status).toBe(401);
  });

  it("列表：新→舊、帶會員信箱與則數；單則：conv＋訊息舊→新", async () => {
    const u1 = await seedUser({ name: "甲", email: "jia@example.com" });
    const u2 = await seedUser({ name: "乙", email: "yi@example.com" });
    const older = await seedConv(u1.id, { title: "舊的對話", updated: "2026-07-18T00:00:00.000Z" });
    const newer = await seedConv(u2.id, { title: "新的對話", updated: "2026-07-19T00:00:00.000Z" });
    await seedMsg(older, "user", "第一句", "2026-07-18T00:00:00.000Z");
    await seedMsg(older, "assistant", "第二句", "2026-07-18T00:00:01.000Z");

    const d: any = await (await list()).json();
    expect(d.total).toBe(2);
    expect(d.rows[0].id).toBe(newer); // 新→舊
    expect(d.rows[0].email).toBe("yi@example.com");
    expect(d.rows[1].id).toBe(older);
    expect(d.rows[1].name).toBe("甲");
    expect(d.rows[1].msgs).toBe(2); // 訊息則數

    const detail: any = await (await one(older)).json();
    expect(detail.conv.title).toBe("舊的對話");
    expect(detail.conv.email).toBe("jia@example.com"); // 誰的對話
    expect(detail.messages.map((m: any) => m.content)).toEqual(["第一句", "第二句"]); // 舊→新
  });

  it("q 搜信箱／標題；user_id 只看一個人；limit/offset 分頁", async () => {
    const u1 = await seedUser({ name: "丙", email: "bing@example.com" });
    const u2 = await seedUser({ name: "丁", email: "ding@example.com" });
    await seedConv(u1.id, { title: "貓咪問題", updated: "2026-07-19T01:00:00.000Z" });
    await seedConv(u2.id, { title: "狗狗問題", updated: "2026-07-19T02:00:00.000Z" });

    const byMail: any = await (await list("?q=bing@example.com")).json();
    expect(byMail.total).toBe(1);
    expect(byMail.rows[0].title).toBe("貓咪問題");

    const byTitle: any = await (await list("?q=狗狗")).json();
    expect(byTitle.total).toBe(1);
    expect(byTitle.rows[0].email).toBe("ding@example.com");

    const byUser: any = await (await list("?user_id=" + u2.id)).json();
    expect(byUser.total).toBe(1);
    expect(byUser.rows[0].user_id).toBe(u2.id);

    const page: any = await (await list("?limit=1&offset=1")).json();
    expect(page.rows.length).toBe(1);
    expect(page.total).toBeGreaterThan(1); // total 是過濾後的全部、不受 limit 影響
  });

  it("找不到的編號 404、爛編號 400", async () => {
    expect((await one(999999)).status).toBe(404);
    expect((await one("abc")).status).toBe(400);
  });
});
