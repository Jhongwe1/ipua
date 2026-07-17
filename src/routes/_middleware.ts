// src/routes/_middleware.ts — 全站中介層：把每一次「頁面瀏覽」寫進 D1（visits 資料表）。
// 只記頁面瀏覽（瀏覽器要 HTML 的請求），不記 /api/*、/logs 與 /admin 管理頁、/img/* 圖片；
// 寫入走 waitUntil（背景執行、不拖慢回應），且全程 try/catch — 記錄失敗絕不影響網站。
import type { Env, RouteCtx } from "../types.js";

const PAGE_PATHS: Record<string, number> = {
  "/": 1,
  "/ip": 1,
  "/ua": 1,
  "/index.html": 1,
  "/news": 1,
  "/articles": 1
};

function shouldLog(request: Request, url: URL): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  const p = url.pathname.toLowerCase().replace(/\/+$/, "") || "/";
  if (p === "/logs" || p === "/admin" || p.indexOf("/api") === 0 || p.indexOf("/img/") === 0) return false;
  // 登入流程、API 中轉轉發、VPN 訂閱抓取都不是「頁面瀏覽」，不記
  if (p.indexOf("/auth") === 0 || p.indexOf("/relay/") === 0 || p.indexOf("/vpn/sub") === 0) return false;
  // 瀏覽器「預先抓取」不是真的瀏覽，跳過
  const purpose = (request.headers.get("sec-purpose") || request.headers.get("purpose") || "").toLowerCase();
  if (purpose.indexOf("prefetch") >= 0 || purpose.indexOf("preview") >= 0) return false;
  // 一般瀏覽器會帶 Accept: text/html；沒帶 Accept 直接打頁面路徑的（多半是機器人）也記下來
  // 文章頁（/news/12、/articles/34）與自訂頁面（/p/about）路徑是動態的，用樣式比對
  const accept = request.headers.get("accept") || "";
  return (
    accept.indexOf("text/html") >= 0 ||
    PAGE_PATHS[p] === 1 ||
    /^\/(news|articles)\/\d+$/.test(p) ||
    /^\/p\/[a-z0-9-]+$/.test(p)
  );
}

async function logVisit(request: Request, env: Env, url: URL): Promise<void> {
  const h = request.headers;
  // cf 欄位依方案／環境可有可無，逐欄防禦式取值

  const cf = (request.cf || {}) as any;
  await env.DB.prepare(
    `INSERT INTO visits (ts, host, path, method, ip, ua, country, city, region, colo, asn, isp, lang, referer, http, tls)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  )
    .bind(
      new Date().toISOString(),
      url.hostname,
      url.pathname + (url.search || ""),
      request.method,
      h.get("cf-connecting-ip") || "",
      (h.get("user-agent") || "").slice(0, 700),
      cf.country || "",
      cf.city || "",
      cf.region || "",
      cf.colo || "",
      cf.asn || null,
      cf.asOrganization || "",
      (h.get("accept-language") || "").slice(0, 200),
      (h.get("referer") || "").slice(0, 500),
      cf.httpProtocol || "",
      cf.tlsVersion || ""
    )
    .run();
}

// 記一次頁面瀏覽（背景、永不影響網站本體）。Pages 時代的 _middleware 與 Workers 版 router
// 共用這一支（單一真相）：router 在分派 handler 前先呼叫它，行為與 Pages 一致。
export function visitLog(context: Pick<RouteCtx, "request" | "env" | "waitUntil">): void {
  const { request, env } = context;
  try {
    const url = new URL(request.url);
    if (env.DB && shouldLog(request, url)) {
      context.waitUntil(logVisit(request, env, url).catch(() => {}));
    }
  } catch (e) {
    /* 記錄永不影響網站本體 */
  }
}

export async function onRequest(context: RouteCtx): Promise<Response> {
  visitLog(context);
  return context.next();
}
