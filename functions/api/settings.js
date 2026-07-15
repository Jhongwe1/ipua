// GET /api/settings — 公開：讀網站公開設定（白名單，只吐這幾個鍵）。
// brand＝站名（settings 表沒 brand 鍵 → 回預設＝正式網址主機名，custom:false）。
// pg_open＝Playground 是否對所有登入會員開放（true/false；沒設過＝false）。
// contact_url＝站長對外聯絡連結（沒設＝空字串，前端就不顯示聯絡鈕）。
import { json, siteBrand } from "../../lib/site.js";
import { pgOpenAll } from "../../lib/auth.js";

export async function onRequestGet({ request, env }) {
  let brand = siteBrand(env, request), custom = false, contact = "";
  try {
    const res = await env.DB.prepare("SELECT k,v FROM settings WHERE k IN ('brand','contact_url')").all();
    (res.results || []).forEach(function (r) {
      if (r.k === "brand" && r.v) { brand = r.v; custom = true; }
      if (r.k === "contact_url" && r.v) contact = r.v;
    });
  } catch (e) { /* 表未建立 → 預設 */ }
  return json({ brand: brand, custom: custom, pg_open: await pgOpenAll(env), contact_url: contact });
}
