// POST /api/admin/media — 站長專用：上傳圖片（後台已先在瀏覽器壓縮）。
// 內容直接放在請求本體（二進位），Content-Type 帶圖片格式，?w=寬&h=高 供後台顯示。
// 存進 D1 的 media 表，之後由 /img/<編號> 讀出；D1 單一值上限 2MB，這裡收 1.8MB 以下。
import { json } from "../../../lib/site.js";
import { adminOk } from "../../../lib/auth.js";
import { audit } from "../../../lib/observe.js";

const MAX_BYTES = 1800000;
const OK_TYPES = { "image/webp": 1, "image/jpeg": 1, "image/png": 1, "image/gif": 1 };

export async function onRequestPost(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  if (!(await adminOk(request, env, url))) return json({ error: "unauthorized" }, 401);
  if (!env.DB) return json({ error: "no-db" }, 500);

  const mime = (request.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!OK_TYPES[mime]) return json({ error: "bad-type", hint: "只收 webp / jpeg / png / gif" }, 415);

  let buf = null;
  try { buf = await request.arrayBuffer(); } catch (e) {}
  if (!buf || buf.byteLength < 50) return json({ error: "empty" }, 400);
  if (buf.byteLength > MAX_BYTES) {
    return json({ error: "too-large", hint: "壓縮後仍超過 1.8MB，請換小一點的圖" }, 413);
  }

  const w = parseInt(url.searchParams.get("w"), 10) || null;
  const h = parseInt(url.searchParams.get("h"), 10) || null;
  try {
    const r = await env.DB.prepare(
      "INSERT INTO media (mime, bytes, w, h, data, created_at) VALUES (?1,?2,?3,?4,?5,?6)"
    ).bind(mime, buf.byteLength, w, h, buf, new Date().toISOString()).run();
    const id = r.meta.last_row_id;
    audit(env, function (p) { context.waitUntil(p); }, request, "media.upload", id,
      mime + " " + buf.byteLength + " bytes");
    return json({ id: id, url: "/img/" + id, bytes: buf.byteLength, w: w, h: h });
  } catch (e) {
    return json({ error: "insert-failed", detail: String(e && e.message || e) }, 500);
  }
}
