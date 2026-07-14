// /api/admin/errors — 站長專用：站內錯誤日誌（errlog 表；relay/pg/oauth/csp 埋點寫入）。
//   GET    ?limit=50&offset=0&src=relay.upstream → { rows, total }（新的在前）
//   DELETE 清空全部
import { json } from "../../../lib/site.js";
import { adminOk } from "../../../lib/auth.js";

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  if (!(await adminOk(request, env, url))) return json({ error: "unauthorized" }, 401);
  if (!env.DB) return json({ error: "no-db" }, 500);
  let limit = parseInt(url.searchParams.get("limit"), 10);
  if (!limit || limit < 1 || limit > 200) limit = 50;
  let offset = parseInt(url.searchParams.get("offset"), 10);
  if (!offset || offset < 0) offset = 0;
  const src = String(url.searchParams.get("src") || "").slice(0, 60);
  try {
    const where = src ? " WHERE src=?1" : "";
    const stmts = [
      env.DB.prepare("SELECT * FROM errlog" + where + " ORDER BY id DESC LIMIT " + limit + " OFFSET " + offset),
      env.DB.prepare("SELECT COUNT(*) AS c FROM errlog" + where)
    ];
    if (src) { stmts[0] = stmts[0].bind(src); stmts[1] = stmts[1].bind(src); }
    const res = await env.DB.batch(stmts);
    return json({ rows: res[0].results || [], total: (res[1].results[0] || {}).c || 0 });
  } catch (e) {
    return json({ error: "query-failed", detail: String(e && e.message || e) }, 500);
  }
}

export async function onRequestDelete({ request, env }) {
  const url = new URL(request.url);
  if (!(await adminOk(request, env, url))) return json({ error: "unauthorized" }, 401);
  if (!env.DB) return json({ error: "no-db" }, 500);
  try {
    await env.DB.prepare("DELETE FROM errlog").run();
    return json({ ok: true });
  } catch (e) {
    return json({ error: "delete-failed", detail: String(e && e.message || e) }, 500);
  }
}
