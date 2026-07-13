// /api/admin/users/<編號> — 站長專用：管理單一會員。
//   PUT    { action: "approve" | "block" | "unblock" | "make_admin" | "drop_admin" }
//          或 { action: "set_services", services: ["relay","vpn","playground"] } — 分服務批准
//   DELETE 刪除帳號（連同其 session）
// approve＝快速鍵：一次批准全部服務。set_services＝精準開關單一服務；
// 給了任何服務就算 approved、全部收回就退回 pending（封鎖中的帳號只改清單、狀態不動）。
// 護欄：站長不能封鎖／降級／刪除「自己」，也不能動到「環境變數指定的站長信箱」帳號
//       （那些是設定裡的老大，只能改設定，不能在網頁上互鎖）。
import { json } from "../../../../lib/site.js";
import { adminOk, getSessionUser, adminEmails, SERVICES } from "../../../../lib/auth.js";

const ACTIONS = {
  approve:    { status: "approved", services: SERVICES.join(",") },
  block:      { status: "blocked" },
  unblock:    { status: "approved" },
  make_admin: { is_admin: 1, status: "approved" },
  drop_admin: { is_admin: 0 }
};

function idOf(params) {
  const id = parseInt(params.id, 10);
  return id > 0 ? id : null;
}

// 這個帳號是不是「設定檔裡欽定的站長」（環境變數 ADMIN_EMAILS）—— 網頁上不能動他
function isRootAdmin(row, env) {
  return adminEmails(env).indexOf(String(row.email || "").toLowerCase()) >= 0;
}

export async function onRequestPut({ request, env, params }) {
  const url = new URL(request.url);
  if (!(await adminOk(request, env, url))) return json({ error: "unauthorized" }, 401);
  const id = idOf(params);
  if (!id || !env.DB) return json({ error: "bad-id" }, 400);

  let body = null;
  try { body = await request.json(); } catch (e) {}
  let act = body && ACTIONS[body.action];
  if (body && body.action === "set_services") {
    // 分服務批准：整包覆蓋服務清單（只收合法服務名，去重）
    const want = Array.isArray(body.services) ? body.services : null;
    if (!want) return json({ error: "bad-input", hint: "set_services 要帶 services 陣列" }, 400);
    const clean = SERVICES.filter(function (s) { return want.indexOf(s) >= 0; });
    act = { services: clean.join(",") };
  }
  if (!act) return json({ error: "bad-action", hint: "action 要是 approve/block/unblock/make_admin/drop_admin/set_services" }, 400);

  const me = await getSessionUser(request, env);   // 金鑰身分時為 null（金鑰＝超級站長，不受自我保護限制）
  const target = await env.DB.prepare("SELECT * FROM users WHERE id=?1").bind(id).first();
  if (!target) return json({ error: "not-found" }, 404);

  const demoting = body.action === "block" || body.action === "drop_admin";
  if (demoting && isRootAdmin(target, env)) {
    return json({ error: "protected", hint: "這是設定檔指定的站長帳號，請改 ADMIN_EMAILS 環境變數" }, 403);
  }
  if (me && me.id === target.id && demoting) {
    return json({ error: "self", hint: "不能封鎖或降級自己" }, 400);
  }

  // 服務清單牽動帳號狀態（封鎖中的帳號狀態不動）：有服務＝approved、全收回＝退回 pending。
  // 解封也一樣看服務清單：原本有服務就直接恢復 approved，沒有就回 pending 等重新批准。
  if (target.status !== "blocked" && body.action === "set_services") {
    act.status = act.services ? "approved" : "pending";
  }
  if (body.action === "unblock" && !String(target.services || "").trim()) {
    act = { status: "pending" };
  }

  const sets = [], binds = [];
  if (act.status !== undefined) { sets.push("status=?" + (binds.length + 1)); binds.push(act.status); }
  if (act.is_admin !== undefined) { sets.push("is_admin=?" + (binds.length + 1)); binds.push(act.is_admin); }
  if (act.services !== undefined) { sets.push("services=?" + (binds.length + 1)); binds.push(act.services); }
  binds.push(id);
  try {
    await env.DB.prepare("UPDATE users SET " + sets.join(",") + " WHERE id=?" + binds.length).bind(...binds).run();
    if (body.action === "block") {
      await env.DB.prepare("DELETE FROM sessions WHERE user_id=?1").bind(id).run();   // 封鎖＝踢下線
    }
    return json({ ok: true });
  } catch (e) {
    return json({ error: "save-failed", detail: String(e && e.message || e) }, 500);
  }
}

export async function onRequestDelete({ request, env, params }) {
  const url = new URL(request.url);
  if (!(await adminOk(request, env, url))) return json({ error: "unauthorized" }, 401);
  const id = idOf(params);
  if (!id || !env.DB) return json({ error: "bad-id" }, 400);

  const me = await getSessionUser(request, env);
  const target = await env.DB.prepare("SELECT * FROM users WHERE id=?1").bind(id).first();
  if (!target) return json({ error: "not-found" }, 404);
  if (isRootAdmin(target, env)) return json({ error: "protected", hint: "設定檔指定的站長帳號不能在此刪除" }, 403);
  if (me && me.id === target.id) return json({ error: "self", hint: "不能刪除自己" }, 400);

  try {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM sessions WHERE user_id=?1").bind(id),
      env.DB.prepare("DELETE FROM users WHERE id=?1").bind(id)
    ]);
    return json({ ok: true });
  } catch (e) {
    return json({ error: "delete-failed", detail: String(e && e.message || e) }, 500);
  }
}
