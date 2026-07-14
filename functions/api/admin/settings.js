// PUT /api/admin/settings — 站長專用：改網站設定。**本體帶哪個鍵就改哪個鍵**（沒帶的不動）：
//   brand:   新站名（最長 60 字）；空字串＝刪掉自訂站名＝還原內建預設（lib/site.js 的 BRAND）。
//            站名用在：分頁標題、og:site_name、JSON-LD、RSS 頻道名。
//   pg_open: true/false — Playground 對所有登入會員開放（不必逐人批准；封鎖者照擋）。
//            存 settings 表 pg_open='1'；false＝刪鍵＝回到逐人批准。
// 回 { ok, brand, custom, pg_open }（改完的現況）。
import { json, BRAND } from "../../../lib/site.js";
import { adminOk, pgOpenAll } from "../../../lib/auth.js";

export async function onRequestPut({ request, env }) {
  const url = new URL(request.url);
  if (!(await adminOk(request, env, url))) return json({ error: "unauthorized" }, 401);
  if (!env.DB) return json({ error: "no-db" }, 500);

  let body = null;
  try { body = await request.json(); } catch (e) {}
  if (!body || typeof body !== "object") return json({ error: "bad-input", hint: "需要 JSON 本體" }, 400);
  if (!("brand" in body) && !("pg_open" in body)) {
    return json({ error: "bad-input", hint: "至少要帶 brand 或 pg_open 其中一個鍵" }, 400);
  }

  try {
    if ("brand" in body) {
      const brand = String(body.brand == null ? "" : body.brand).trim().slice(0, 60);
      if (!brand) await env.DB.prepare("DELETE FROM settings WHERE k='brand'").run();
      else await env.DB.prepare(
        "INSERT INTO settings (k, v) VALUES ('brand', ?1) ON CONFLICT(k) DO UPDATE SET v=excluded.v"
      ).bind(brand).run();
    }
    if ("pg_open" in body) {
      if (body.pg_open) await env.DB.prepare(
        "INSERT INTO settings (k, v) VALUES ('pg_open', '1') ON CONFLICT(k) DO UPDATE SET v=excluded.v"
      ).run();
      else await env.DB.prepare("DELETE FROM settings WHERE k='pg_open'").run();
    }
    const r = await env.DB.prepare("SELECT v FROM settings WHERE k='brand'").first();
    return json({
      ok: true,
      brand: (r && r.v) || BRAND,
      custom: !!(r && r.v),
      pg_open: await pgOpenAll(env)
    });
  } catch (e) {
    return json({ error: "save-failed", detail: String(e && e.message || e) }, 500);
  }
}
