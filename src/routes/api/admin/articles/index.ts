// /api/admin/articles — 管理員專用（給 /admin 後台呼叫）：
//   GET  列出全部文章（含草稿），供後台列表
//   POST 新增文章
// 驗證與 /api/logs 相同：Authorization: Bearer <LOGS_TOKEN>；localhost 開發免驗證。
import { json } from "../../../../lib/site.js";
import { adminOk } from "../../../../lib/auth.js";
import { audit } from "../../../../lib/observe.js";
import type { RouteCtx } from "../../../../types.js";

export interface ArticleInput {
  category: string;
  status: string;
  title: string;
  summary: string;
  cover: string;
  body_md: string;
}

// 表單欄位整理與上限（title 必填；category / status 只收白名單值）

export function cleanArticle(b: any): ArticleInput | null {
  if (!b || typeof b !== "object") return null;
  const title = String(b.title == null ? "" : b.title)
    .trim()
    .slice(0, 200);
  if (!title) return null;
  return {
    category: b.category === "article" ? "article" : "news",
    status: b.status === "published" ? "published" : "draft",
    title: title,
    summary: String(b.summary == null ? "" : b.summary)
      .trim()
      .slice(0, 500),
    cover: String(b.cover == null ? "" : b.cover)
      .trim()
      .slice(0, 300),
    body_md: String(b.body_md == null ? "" : b.body_md).slice(0, 200000)
  };
}

export async function onRequestGet({ request, env }: RouteCtx): Promise<Response> {
  const url = new URL(request.url);
  if (!(await adminOk(request, env, url))) return json({ error: "unauthorized" }, 401);
  if (!env.DB) return json({ error: "no-db" }, 500);
  try {
    const res = await env.DB.prepare(
      "SELECT id,category,title,summary,cover,status,views,created_at,updated_at,published_at " +
        "FROM articles ORDER BY updated_at DESC LIMIT 500"
    ).all();
    return json({ rows: res.results || [] });
  } catch (e: any) {
    return json({ error: "query-failed", detail: String((e && e.message) || e) }, 500);
  }
}

export async function onRequestPost(context: RouteCtx): Promise<Response> {
  const { request, env } = context;
  const url = new URL(request.url);
  if (!(await adminOk(request, env, url))) return json({ error: "unauthorized" }, 401);
  if (!env.DB) return json({ error: "no-db" }, 500);

  let body: any = null;
  try {
    body = await request.json();
  } catch (e) {}
  const a = cleanArticle(body);
  if (!a) return json({ error: "bad-input", hint: "標題不能是空的" }, 400);

  const now = new Date().toISOString();
  try {
    const r = await env.DB.prepare(
      "INSERT INTO articles (category,title,summary,cover,body_md,status,views,created_at,updated_at,published_at) " +
        "VALUES (?1,?2,?3,?4,?5,?6,0,?7,?7,?8)"
    )
      .bind(
        a.category,
        a.title,
        a.summary,
        a.cover,
        a.body_md,
        a.status,
        now,
        a.status === "published" ? now : null
      )
      .run();
    audit(
      env,
      function (p) {
        context.waitUntil(p);
      },
      request,
      "articles.create",
      r.meta.last_row_id,
      a.title.slice(0, 80) + " [" + a.category + "/" + a.status + "]"
    );
    return json({ id: r.meta.last_row_id, status: a.status });
  } catch (e: any) {
    return json({ error: "insert-failed", detail: String((e && e.message) || e) }, 500);
  }
}
