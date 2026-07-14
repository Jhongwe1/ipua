// @ts-check
// lib/observe.js — 站內可觀測性（2026-07-14 v1.0.0）：
//   reportError → errlog 表（/logs 錯誤分頁、/api/admin/errors）
//   audit       → audit_log 表（誰、何時、對誰、做了什麼；/api/admin 變更端點全掛）
// 兩者全包 try/catch、永不 throw — 觀測功能絕不弄掛正職服務。
// 拍板：告警先只做站內（無 Telegram/Sentry，記在 DEBT.md）。
import { getSessionUser } from "./auth.js";

/**
 * 立刻寫一列 errlog（回傳的 Promise 永不 reject）。
 * 已經在 waitUntil 任務裡的呼叫端用這個直接 await。
 * @param {any} env
 * @param {string} src 出錯位置代號（relay.upstream / pg.stream / oauth.callback / csp …）
 * @param {unknown} err Error 或字串
 * @param {{user_id?:number|null, path?:string, detail?:string}} [extra]
 * @returns {Promise<void>}
 */
export async function reportErrorNow(env, src, err, extra) {
  try {
    if (!env || !env.DB) return;
    const e = /** @type {any} */ (err);
    const msg = String((e && e.message) || e || "").slice(0, 500);
    const detail = String((extra && extra.detail) || (e && e.stack) || "").slice(0, 2000);
    await env.DB.prepare(
      "INSERT INTO errlog (ts,src,msg,detail,user_id,path) VALUES (?1,?2,?3,?4,?5,?6)"
    ).bind(
      new Date().toISOString(), String(src).slice(0, 60), msg, detail,
      (extra && extra.user_id) || null, String((extra && extra.path) || "").slice(0, 300)
    ).run();
  } catch (e2) { /* 記錄失敗就算了 */ }
}

/**
 * 背景寫 errlog（掛 waitUntil，不拖慢回應）。
 * @param {any} env
 * @param {(p:Promise<any>)=>void} waitUntil context.waitUntil（或包一層的函式）
 * @param {string} src
 * @param {unknown} err
 * @param {{user_id?:number|null, path?:string, detail?:string}} [extra]
 */
export function reportError(env, waitUntil, src, err, extra) {
  try { waitUntil(reportErrorNow(env, src, err, extra)); } catch (e) {}
}

/**
 * 管理操作稽核：actor 是登入站長的 email；用管理金鑰（Bearer）時記 'token'。
 * summary 絕不可含秘密（渠道金鑰只記「有無更新」）— 這是呼叫端的責任，這裡再截長度。
 * @param {any} env
 * @param {(p:Promise<any>)=>void} waitUntil
 * @param {Request} request 用來認 actor（session cookie）
 * @param {string} action 例：users.set_services / settings.put / relay.channel.create
 * @param {string|number} target 對象（user id、channel slug…）
 * @param {string} [summary]
 */
export function audit(env, waitUntil, request, action, target, summary) {
  try {
    waitUntil((async function () {
      let actor = "token";
      try {
        const u = await getSessionUser(request, env);
        if (u && u.email) actor = String(u.email);
      } catch (e) {}
      await env.DB.prepare(
        "INSERT INTO audit_log (ts,actor,action,target,summary) VALUES (?1,?2,?3,?4,?5)"
      ).bind(
        new Date().toISOString(), actor.slice(0, 200), String(action).slice(0, 80),
        String(target == null ? "" : target).slice(0, 200), String(summary || "").slice(0, 500)
      ).run();
    })().catch(function () {}));
  } catch (e) {}
}
