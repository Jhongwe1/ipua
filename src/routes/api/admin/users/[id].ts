// /api/admin/users/<編號> — 管理員專用：管理單一會員。
//   PUT    { action: "approve" | "block" | "unblock" | "make_admin" | "drop_admin" }
//          或 { action: "set_services", services: ["relay","vpn","playground"] } — 分服務批准
//          或 { action: "set_quota", quota_relay_day?, quota_pg_day?, rl_per_min? } — 個人配額覆寫
//            （帶哪鍵改哪鍵；值可為 0 以上整數或 null＝清掉覆寫、回到全域預設）
//          或 { action: "revoke_sessions" } — 撤銷該會員所有登入裝置（session 全刪；帳號狀態不動）
//   DELETE 刪除帳號（連同其 session）
// 所有變更都寫 audit_log（誰、何時、對誰、做了什麼）。
// approve＝快速鍵：一次批准全部服務。set_services＝精準開關單一服務；
// 給了任何服務就算 approved、全部收回就退回 pending（封鎖中的帳號只改清單、狀態不動）。
// 護欄：管理員不能封鎖／降級／刪除「自己」，也不能動到「環境變數指定的管理員信箱」帳號
//       （那些是設定裡的老大，只能改設定，不能在網頁上互鎖）。
import { json } from "../../../../lib/site.js";
import { adminOk, getSessionUser, adminEmails, SERVICES } from "../../../../lib/auth.js";
import { audit } from "../../../../lib/observe.js";
import type { Env, RouteCtx, UserRow } from "../../../../types.js";

const ACTIONS: Record<string, Record<string, unknown>> = {
  approve: { status: "approved", services: SERVICES.join(",") },
  block: { status: "blocked" },
  unblock: { status: "approved" },
  make_admin: { is_admin: 1, status: "approved" },
  drop_admin: { is_admin: 0 }
};

// set_quota 能改的欄位（與 migration 0002 的 users 新欄一一對應）
const QUOTA_FIELDS = ["quota_relay_day", "quota_pg_day", "rl_per_min"];

function idOf(params: RouteCtx["params"]): number | null {
  const id = parseInt(String(params.id), 10);
  return id > 0 ? id : null;
}

// 這個帳號是不是「設定檔裡欽定的管理員」（環境變數 ADMIN_EMAILS）—— 網頁上不能動他
function isRootAdmin(row: UserRow, env: Env): boolean {
  return adminEmails(env).indexOf(String(row.email || "").toLowerCase()) >= 0;
}

export async function onRequestPut(context: RouteCtx): Promise<Response> {
  const { request, env, params } = context;
  const url = new URL(request.url);
  if (!(await adminOk(request, env, url))) return json({ error: "unauthorized" }, 401);
  const id = idOf(params);
  if (!id || !env.DB) return json({ error: "bad-id" }, 400);
  const wu = function (p: Promise<unknown>) {
    context.waitUntil(p);
  };

  let body: any = null;
  try {
    body = await request.json();
  } catch (e) {}
  // 只認自有屬性，並且複製一份。兩個理由：
  //   1. body.action = "constructor"／"__proto__"／"toString" 會從 Object.prototype 撈到
  //      truthy 的東西，繞過下面的 bad-action 檢查，最後組出空的 SET 子句 → SQL 語法錯 → 500
  //      （而不是乾淨的 400）。
  //   2. act 之後會被就地寫入（set_services 那條的 act.status），直接用 ACTIONS 裡的物件
  //      等於改到模組層級的共用常數 —— 在長壽的 isolate 上會污染後續所有請求。
  //      目前的分支剛好都先換成新物件，但這是「靠巧合成立」，不該留給下一個人踩。
  let act: Record<string, unknown> | undefined =
    body && Object.prototype.hasOwnProperty.call(ACTIONS, body.action)
      ? Object.assign({}, ACTIONS[body.action])
      : undefined;
  if (body && body.action === "set_services") {
    // 分服務批准：整包覆蓋服務清單（只收合法服務名，去重）
    const want = Array.isArray(body.services) ? body.services : null;
    if (!want) return json({ error: "bad-input", hint: "set_services 要帶 services 陣列" }, 400);
    const clean = SERVICES.filter(function (s: string) {
      return want.indexOf(s) >= 0;
    });
    act = { services: clean.join(",") };
  }
  if (body && body.action === "set_quota") {
    // 個人配額覆寫：帶哪鍵改哪鍵；null／空字串＝清掉覆寫（回到全域預設）
    act = {};
    let touched = 0;
    for (const k of QUOTA_FIELDS) {
      if (!(k in body)) continue;
      const v = body[k];
      if (v === null || v === "") {
        act[k] = null;
        touched++;
        continue;
      }
      const n = parseInt(v, 10);
      if (!Number.isFinite(n) || n < 0 || String(n) !== String(v).trim()) {
        return json({ error: "bad-input", hint: k + " 要是 0 以上的整數，或 null＝回到全域預設" }, 400);
      }
      act[k] = n;
      touched++;
    }
    if (!touched)
      return json(
        {
          error: "bad-input",
          hint: "set_quota 至少要帶一個配額鍵（quota_relay_day / quota_pg_day / rl_per_min）"
        },
        400
      );
  }
  if (body && body.action === "revoke_sessions") act = {}; // 不改欄位，於下方特別處理
  if (!act)
    return json(
      {
        error: "bad-action",
        hint: "action 要是 approve/block/unblock/make_admin/drop_admin/set_services/set_quota/revoke_sessions"
      },
      400
    );

  const me = await getSessionUser(request, env); // 金鑰身分時為 null（金鑰＝超級管理員，不受自我保護限制）
  const target = await env.DB.prepare("SELECT * FROM users WHERE id=?1").bind(id).first<UserRow>();
  if (!target) return json({ error: "not-found" }, 404);

  // 撤銷所有裝置：不動帳號狀態，只把該會員的 session 全刪（下次請求就要重新登入）
  if (body.action === "revoke_sessions") {
    try {
      await env.DB.prepare("DELETE FROM sessions WHERE user_id=?1").bind(id).run();
      audit(env, wu, request, "users.revoke_sessions", id, target.email);
      return json({ ok: true });
    } catch (e: any) {
      return json({ error: "save-failed", detail: String((e && e.message) || e) }, 500);
    }
  }

  const demoting = body.action === "block" || body.action === "drop_admin";
  if (demoting && isRootAdmin(target, env)) {
    return json({ error: "protected", hint: "這是設定檔指定的管理員帳號，請改 ADMIN_EMAILS 環境變數" }, 403);
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

  const sets: string[] = [],
    binds: unknown[] = [];
  ["status", "is_admin", "services"].concat(QUOTA_FIELDS).forEach(function (k) {
    if (act[k] !== undefined) {
      sets.push(k + "=?" + (binds.length + 1));
      binds.push(act[k]);
    }
  });
  binds.push(id);
  try {
    await env.DB.prepare("UPDATE users SET " + sets.join(",") + " WHERE id=?" + binds.length)
      .bind(...binds)
      .run();
    if (body.action === "block") {
      await env.DB.prepare("DELETE FROM sessions WHERE user_id=?1").bind(id).run(); // 封鎖＝踢下線
    }
    // 稽核：set_services 記清單、set_quota 記改了哪些鍵值，其餘記動作名（都不含秘密）
    const detail =
      body.action === "set_services"
        ? act.services || "（清空）"
        : body.action === "set_quota"
          ? Object.keys(act)
              .map(function (k) {
                return k + "=" + String(act![k]);
              })
              .join(",")
          : "";
    audit(
      env,
      wu,
      request,
      "users." + body.action,
      id,
      (target.email || "") + (detail ? " → " + detail : "")
    );
    return json({ ok: true });
  } catch (e: any) {
    return json({ error: "save-failed", detail: String((e && e.message) || e) }, 500);
  }
}

export async function onRequestDelete(context: RouteCtx): Promise<Response> {
  const { request, env, params } = context;
  const url = new URL(request.url);
  if (!(await adminOk(request, env, url))) return json({ error: "unauthorized" }, 401);
  const id = idOf(params);
  if (!id || !env.DB) return json({ error: "bad-id" }, 400);

  const me = await getSessionUser(request, env);
  const target = await env.DB.prepare("SELECT * FROM users WHERE id=?1").bind(id).first<UserRow>();
  if (!target) return json({ error: "not-found" }, 404);
  if (isRootAdmin(target, env))
    return json({ error: "protected", hint: "設定檔指定的管理員帳號不能在此刪除" }, 403);
  if (me && me.id === target.id) return json({ error: "self", hint: "不能刪除自己" }, 400);

  try {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM sessions WHERE user_id=?1").bind(id),
      env.DB.prepare("DELETE FROM users WHERE id=?1").bind(id)
    ]);
    audit(
      env,
      function (p) {
        context.waitUntil(p);
      },
      request,
      "users.delete",
      id,
      target.email || ""
    );
    return json({ ok: true });
  } catch (e: any) {
    return json({ error: "delete-failed", detail: String((e && e.message) || e) }, 500);
  }
}
