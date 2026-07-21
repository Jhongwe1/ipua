// src/lib/observe.ts — 站內可觀測性（2026-07-14 v1.0.0）：
//   reportError → errlog 表（/logs 錯誤分頁、/api/admin/errors）
//   audit       → audit_log 表（誰、何時、對誰、做了什麼；/api/admin 變更端點全掛）
// 兩者全包 try/catch、永不 throw — 觀測功能絕不弄掛正職服務。
// 拍板：告警先只做站內（無 Telegram/Sentry，記在 DEBT.md）。
import { getSessionUser } from "./auth.js";
import type { Env } from "../types.js";

export interface ErrExtra {
  user_id?: number | null;
  path?: string;
  detail?: string;
}

/* ===== 秘密遮罩（2026-07-22）=====
   errlog 是「第三方與攻擊者的文字」最容易落地的地方：chat.ts 把上游回應原文塞進 detail，
   而主打的 custom 廉價轉售商常在錯誤訊息裡回顯**完整的上游金鑰**。這張表接著被
   /api/admin/errors 讀、被每日 cron 備份進 R2、被 tgAlertScan 推去 Telegram —— 一次外洩四個地方。

   刻意放在 observe 這一層而不是各個呼叫點：呼叫點會一直增加（現在 12 處），
   放這裡的話「以後新寫的 reportError」自動受保護，不必記得。

   取捨：遮罩留下前綴（sk-[redacted]）而不是整段抹掉 —— 除錯時「這裡本來有一把
   OpenAI 金鑰」是有用的資訊，金鑰本身不是。替換字串不會被自己的樣式再次命中（冪等）。 */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/sk-[A-Za-z0-9_-]{16,}/g, "sk-[redacted]"], // OpenAI／Anthropic（sk-ant-…）／多數相容轉售商
  [/AIza[A-Za-z0-9_-]{30,}/g, "AIza[redacted]"], // Google／Gemini
  [/uak-[a-z2-7]{16,64}/g, "uak-[redacted]"], // 本站會員金鑰（會員的憑證同樣不該進日誌）
  [/\b\d{6,12}:[A-Za-z0-9_-]{30,}/g, "[redacted-tg-token]"] // Telegram bot token
];

/** 把常見的憑證樣式換成標記。永不 throw；對沒有秘密的字串一字不動。 */
export function redactSecrets(s: unknown): string {
  let out = String(s == null ? "" : s);
  for (const [re, mark] of SECRET_PATTERNS) out = out.replace(re, mark);
  return out;
}

/**
 * 立刻寫一列 errlog（回傳的 Promise 永不 reject）。
 * 已經在 waitUntil 任務裡的呼叫端用這個直接 await。
 * src 是出錯位置代號（relay.upstream / pg.stream / oauth.callback / csp …）。
 */
export async function reportErrorNow(env: Env, src: string, err: unknown, extra?: ErrExtra): Promise<void> {
  try {
    if (!env || !env.DB) return;
    const e = err as { message?: unknown; stack?: unknown } | null | undefined;
    // 先遮罩再截斷：反過來的話，被 slice 切斷的金鑰尾巴會match 不到樣式而留在庫裡。
    const msg = redactSecrets((e && e.message) || e || "").slice(0, 500);
    const detail = redactSecrets((extra && extra.detail) || (e && e.stack) || "").slice(0, 2000);
    await env.DB.prepare("INSERT INTO errlog (ts,src,msg,detail,user_id,path) VALUES (?1,?2,?3,?4,?5,?6)")
      .bind(
        new Date().toISOString(),
        String(src).slice(0, 60),
        msg,
        detail,
        (extra && extra.user_id) || null,
        String((extra && extra.path) || "").slice(0, 300)
      )
      .run();
  } catch (e2) {
    /* 記錄失敗就算了 */
  }
}

/**
 * 背景寫 errlog（掛 waitUntil，不拖慢回應）。
 * waitUntil 是 context.waitUntil（或包一層的函式）。
 */
export function reportError(
  env: Env,
  waitUntil: (p: Promise<unknown>) => void,
  src: string,
  err: unknown,
  extra?: ErrExtra
): void {
  try {
    waitUntil(reportErrorNow(env, src, err, extra));
  } catch (e) {}
}

/**
 * 管理操作稽核：actor 是登入管理員的 email；用管理金鑰（Bearer）時記 'token'。
 * summary 絕不可含秘密（渠道金鑰只記「有無更新」）— 這是呼叫端的責任，
 * 這裡再過一次 redactSecrets 當縱深防禦（呼叫點會一直增加，總有一天有人忘記）並截長度。
 * action 例：users.set_services / settings.put / relay.channel.create；target 是對象（user id、channel slug…）。
 */
export function audit(
  env: Env,
  waitUntil: (p: Promise<unknown>) => void,
  request: Request,
  action: string,
  target: string | number | null | undefined,
  summary?: string
): void {
  try {
    waitUntil(
      (async function () {
        let actor = "token";
        try {
          const u = await getSessionUser(request, env);
          if (u && u.email) actor = String(u.email);
        } catch (e) {}
        await env.DB.prepare("INSERT INTO audit_log (ts,actor,action,target,summary) VALUES (?1,?2,?3,?4,?5)")
          .bind(
            new Date().toISOString(),
            actor.slice(0, 200),
            String(action).slice(0, 80),
            String(target == null ? "" : target).slice(0, 200),
            redactSecrets(summary || "").slice(0, 500)
          )
          .run();
      })().catch(function () {})
    );
  } catch (e) {}
}
