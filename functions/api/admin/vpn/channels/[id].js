// /api/admin/vpn/channels/<編號> — 站長專用：PUT 更新渠道、DELETE 刪除渠道。
// PUT 整包覆蓋，唯一例外：本體「沒帶 url 欄位」＝上游訂閱網址保留舊值
//（帶空字串 ""＝清掉）。這樣改名／停用不用重貼網址。
import { json } from "../../../../../lib/site.js";
import { adminOk } from "../../../../../lib/auth.js";
import { audit } from "../../../../../lib/observe.js";
import { cleanChannel, maskRow } from "./index.js";

function idOf(params) {
  const id = parseInt(params.id, 10);
  return id > 0 ? id : null;
}

export async function onRequestPut(context) {
  const { request, env, params } = context;
  const url = new URL(request.url);
  if (!(await adminOk(request, env, url))) return json({ error: "unauthorized" }, 401);
  const id = idOf(params);
  if (!id || !env.DB) return json({ error: "bad-id" }, 400);

  let body = null;
  try { body = await request.json(); } catch (e) {}
  const c = cleanChannel(body);
  if (c.err) return json({ error: "bad-input", hint: c.err }, 400);

  try {
    const old = await env.DB.prepare("SELECT * FROM vpn_channels WHERE id=?1").bind(id).first();
    if (!old) return json({ error: "not-found" }, 404);
    const u = c.ch.url === undefined ? old.url : c.ch.url;
    if (c.ch.kind === "sub" && !u) return json({ error: "bad-input", hint: "sub 渠道要填上游訂閱網址" }, 400);
    await env.DB.prepare(
      "UPDATE vpn_channels SET name=?1,kind=?2,url=?3,nodes=?4,enabled=?5 WHERE id=?6"
    ).bind(c.ch.name, c.ch.kind, u, c.ch.nodes, c.ch.enabled, id).run();
    const row = await env.DB.prepare("SELECT * FROM vpn_channels WHERE id=?1").bind(id).first();
    const urlNote = c.ch.url === undefined ? "保留" : (c.ch.url ? "更新" : "清除");
    audit(env, function (p) { context.waitUntil(p); }, request, "vpn.channel.update", id,
      c.ch.name + " enabled=" + c.ch.enabled + " 上游網址:" + urlNote);
    return json({ row: maskRow(row) });
  } catch (e) {
    return json({ error: "update-failed", detail: String(e && e.message || e) }, 500);
  }
}

export async function onRequestDelete(context) {
  const { request, env, params } = context;
  const url = new URL(request.url);
  if (!(await adminOk(request, env, url))) return json({ error: "unauthorized" }, 401);
  const id = idOf(params);
  if (!id || !env.DB) return json({ error: "bad-id" }, 400);
  try {
    const old = await env.DB.prepare("SELECT name FROM vpn_channels WHERE id=?1").bind(id).first();
    await env.DB.prepare("DELETE FROM vpn_channels WHERE id=?1").bind(id).run();
    audit(env, function (p) { context.waitUntil(p); }, request, "vpn.channel.delete", id, (old && old.name) || "");
    return json({ ok: true });
  } catch (e) {
    return json({ error: "delete-failed", detail: String(e && e.message || e) }, 500);
  }
}
