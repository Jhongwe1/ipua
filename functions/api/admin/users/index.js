// GET /api/admin/users — 站長專用：列出所有會員（給 /members 頁）。
// 不回任何金鑰明文；只回狀態、用量、最後登入這些管理需要的欄位。
import { json } from "../../../../lib/site.js";
import { adminOk } from "../../../../lib/auth.js";

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  if (!(await adminOk(request, env, url))) return json({ error: "unauthorized" }, 401);
  if (!env.DB) return json({ error: "no-db" }, 500);
  try {
    const res = await env.DB.prepare(
      "SELECT id,email,name,picture,status,services,is_admin,api_key_at,relay_calls,vpn_pulls,created_at,last_login " +
      "FROM users ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, last_login DESC"
    ).all();
    return json({ rows: res.results || [] });
  } catch (e) {
    return json({ error: "query-failed", detail: String(e && e.message || e) }, 500);
  }
}
