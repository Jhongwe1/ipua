// PUT /api/admin/menu — 站長專用：整包覆蓋側邊欄選單。
// 本體 { items: [ { kind:"section"|"link", label, label_en?, url? }, … ] }，依陣列順序顯示。
// 傳空陣列 = 清空自訂選單 = 還原成內建預設。整個覆蓋動作在同一個交易裡（batch），不會存到一半。
import { json } from "../../../lib/site.js";
import { adminOk } from "../../../lib/auth.js";
import { audit } from "../../../lib/observe.js";

const MAX_ITEMS = 60;

export async function onRequestPut(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  if (!(await adminOk(request, env, url))) return json({ error: "unauthorized" }, 401);
  if (!env.DB) return json({ error: "no-db" }, 500);

  let body = null;
  try { body = await request.json(); } catch (e) {}
  const items = body && Array.isArray(body.items) ? body.items : null;
  if (!items) return json({ error: "bad-input", hint: "需要 items 陣列" }, 400);
  if (items.length > MAX_ITEMS) return json({ error: "too-many", hint: "選單最多 " + MAX_ITEMS + " 項" }, 400);

  const clean = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i] || {};
    const kind = it.kind === "section" ? "section" : "link";
    const label = String(it.label == null ? "" : it.label).trim().slice(0, 60);
    if (!label) return json({ error: "bad-input", hint: "第 " + (i + 1) + " 項沒有名稱" }, 400);
    const label_en = String(it.label_en == null ? "" : it.label_en).trim().slice(0, 60);
    let u = "";
    if (kind === "link") {
      u = String(it.url == null ? "" : it.url).trim().slice(0, 300);
      // 只收站內路徑或 http(s) 網址 — 擋掉 javascript: 之類會在點擊時執行程式的網址
      if (!/^(\/|https?:\/\/)/.test(u)) {
        return json({ error: "bad-url", hint: "「" + label + "」的網址要以 / 或 http(s):// 開頭" }, 400);
      }
    }
    clean.push({ kind: kind, label: label, label_en: label_en, url: u });
  }

  try {
    const stmts = [env.DB.prepare("DELETE FROM menu")];
    clean.forEach(function (c, i) {
      stmts.push(env.DB.prepare(
        "INSERT INTO menu (pos, kind, label, label_en, url) VALUES (?1,?2,?3,?4,?5)"
      ).bind(i, c.kind, c.label, c.label_en, c.url));
    });
    await env.DB.batch(stmts);
    audit(env, function (p) { context.waitUntil(p); }, request, "menu.put", "",
      clean.length ? clean.length + " 項" : "清空＝還原預設");
    return json({ ok: true, count: clean.length, custom: clean.length > 0 });
  } catch (e) {
    return json({ error: "save-failed", detail: String(e && e.message || e) }, 500);
  }
}
