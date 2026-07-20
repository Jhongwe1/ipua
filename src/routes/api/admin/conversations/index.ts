// GET /api/admin/conversations — 管理員專用：全站 Playground 對話總表（/logs 對話紀錄分頁的數據源）。
//   ?limit=50&offset=0&q=關鍵字&user_id=3
//   → { rows, total }；新→舊（updated_at DESC），每列帶會員 email／name 與訊息則數。
// 只讀 —— 這裡不提供刪除；會員自己的刪除在 /api/playground/conversations/{id}。
import { json } from "../../../../lib/site.js";
import { adminOk } from "../../../../lib/auth.js";
import type { RouteCtx } from "../../../../types.js";

export async function onRequestGet({ request, env }: RouteCtx): Promise<Response> {
  const url = new URL(request.url);
  if (!(await adminOk(request, env, url))) return json({ error: "unauthorized" }, 401);
  if (!env.DB) return json({ error: "no-db" }, 500);

  let limit = parseInt(url.searchParams.get("limit") || "", 10);
  if (!limit || limit < 1 || limit > 200) limit = 50;
  let offset = parseInt(url.searchParams.get("offset") || "", 10);
  if (!offset || offset < 0) offset = 0;
  const q = String(url.searchParams.get("q") || "")
    .trim()
    .slice(0, 80);
  const userId = parseInt(url.searchParams.get("user_id") || "", 10);

  // 條件拼裝：?1 起算，後面的 limit/offset 直接內嵌（上面已限制成整數）。
  const where: string[] = [];
  const binds: unknown[] = [];
  if (userId > 0) {
    binds.push(userId);
    where.push("c.user_id=?" + binds.length);
  }
  if (q) {
    // 標題、會員信箱、姓名、模型、渠道 —— 訊息內容不進搜尋（掃全表太重）
    binds.push("%" + q + "%");
    const p = "?" + binds.length;
    where.push(
      "(c.title LIKE " +
        p +
        " OR u.email LIKE " +
        p +
        " OR u.name LIKE " +
        p +
        " OR c.model LIKE " +
        p +
        " OR c.channel LIKE " +
        p +
        ")"
    );
  }
  const cond = where.length ? " WHERE " + where.join(" AND ") : "";

  try {
    // 沒有條件時不呼叫 .bind()（跟 errors.ts 同款寫法，避免空參數的邊角行為）
    const prep = (sql: string) => {
      const s = env.DB.prepare(sql);
      return binds.length ? s.bind(...binds) : s;
    };
    const res = await env.DB.batch([
      prep(
        "SELECT c.id, c.user_id, c.title, c.channel, c.model, c.created_at, c.updated_at, " +
          "u.email, u.name, " +
          "(SELECT COUNT(*) FROM pg_messages m WHERE m.conv_id=c.id) AS msgs " +
          "FROM pg_conversations c LEFT JOIN users u ON u.id=c.user_id" +
          cond +
          " ORDER BY c.updated_at DESC, c.id DESC LIMIT " +
          limit +
          " OFFSET " +
          offset
      ),
      prep("SELECT COUNT(*) AS c FROM pg_conversations c LEFT JOIN users u ON u.id=c.user_id" + cond)
    ]);
    return json({
      rows: res[0].results || [],
      total: ((res[1].results[0] || {}) as { c?: number }).c || 0
    });
  } catch (e: any) {
    return json({ error: "query-failed", detail: String((e && e.message) || e) }, 500);
  }
}
