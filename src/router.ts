// src/router.ts — Workers 版路由器（v2.0.0 Phase D，取代 Cloudflare Pages 檔案系統路由）。
//
// 設計：把 functions/ 既有的 onRequestGet/Post/… handler 掛到一張「註冊順序即優先序」的
// 路由表上（見 src/routes.ts）。functions/ 檔案原地不動 —— 同一個 commit 隨時能把部署
// 回滾到 Pages（wrangler.pages.toml）。線性掃描；樣式段 :name＝單段、*name＝餘段陣列
// （與 Pages 的 params 同形，例如 relay 的 params.path 是 string[]，relay handler 零改動）。
//
// 流程：visitLog（頁面瀏覽紀錄，與 Pages _middleware 共用同一支）→ 比對路由 →
// 建 Pages 形 context 分派 → 全程 errorBoundary（未捕捉例外 → reportError＋500）→
// 無匹配 → env.ASSETS.fetch（靜態檔或 SPA fallback，吃 /ip /ua 這些前端路由）。

import { visitLog } from "../functions/_middleware.js";
import { reportErrorNow } from "../lib/observe.js";
import { ROUTES } from "./routes.js";

export type Handler = (ctx: RouteCtx) => Response | Promise<Response>;
export type MethodMap = Record<string, Handler>;

export interface Env {
  DB: D1Database;
  ASSETS: { fetch: (req: Request) => Promise<Response> };
  [key: string]: unknown;
}

// 傳給 handler 的 context：與 Pages 的 EventContext 同形（request/env/params/waitUntil/…）
export interface RouteCtx {
  request: Request;
  env: Env;
  params: Record<string, string | string[]>;
  data: Record<string, unknown>;
  waitUntil: (p: Promise<unknown>) => void;
  passThroughOnException: () => void;
  next: () => Promise<Response>;
}

interface CompiledRoute {
  segs: string[];       // ["api","articles",":id"]
  restName: string | null;   // *path 的名字（null＝非 catch-all）
  handlers: MethodMap;  // { GET, POST, … } 或 { ALL }（onRequest）
}

// 把 "/api/articles/:id" 或 "/relay/*path" 編成 CompiledRoute
export function compile(pattern: string, handlers: MethodMap): CompiledRoute {
  const raw = pattern.split("/").filter(Boolean);
  let restName: string | null = null;
  const segs: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const s = raw[i];
    if (s.charAt(0) === "*") { restName = s.slice(1) || "path"; break; }  // 餘段一定是最後一段
    segs.push(s);
  }
  return { segs, restName, handlers };
}

// 比對單一路由；命中回 params（含 :name 與 *name），否則回 null
function match(route: CompiledRoute, parts: string[]): Record<string, string | string[]> | null {
  if (route.restName === null) {
    if (parts.length !== route.segs.length) return null;
  } else if (parts.length < route.segs.length) {
    return null;
  }
  const params: Record<string, string | string[]> = {};
  for (let i = 0; i < route.segs.length; i++) {
    const seg = route.segs[i];
    if (seg.charAt(0) === ":") params[seg.slice(1)] = safeDecode(parts[i]);
    else if (seg !== parts[i]) return null;
  }
  if (route.restName !== null) params[route.restName] = parts.slice(route.segs.length).map(safeDecode);
  return params;
}

function safeDecode(s: string): string {
  try { return decodeURIComponent(s); } catch (e) { return s; }
}

const COMPILED: CompiledRoute[] = ROUTES.map((r) => compile(r[0], r[1]));

function json(obj: unknown, status: number): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}

export async function handle(request: Request, env: Env, exec: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean).map((p) => p);   // 保留原始編碼，match 時才解
  const method = request.method === "HEAD" ? "GET" : request.method;

  const ctx: RouteCtx = {
    request,
    env,
    params: {},
    data: {},
    waitUntil: (p) => { try { exec.waitUntil(Promise.resolve(p)); } catch (e) { /* 測試環境可能無 exec */ } },
    passThroughOnException: () => { try { exec.passThroughOnException(); } catch (e) {} },
    next: () => env.ASSETS.fetch(request)
  };

  // 1) 頁面瀏覽紀錄（背景、永不影響回應）——與 Pages _middleware 同一支
  visitLog(ctx as unknown as { request: Request; env: { DB?: D1Database }; waitUntil: (p: Promise<unknown>) => void });

  // 2) 線性掃描路由表（註冊順序即優先序）
  for (let i = 0; i < COMPILED.length; i++) {
    const route = COMPILED[i];
    const params = match(route, parts);
    if (!params) continue;
    const fn = route.handlers.ALL || route.handlers[method];
    if (!fn) return json({ error: "method-not-allowed" }, 405);
    ctx.params = params;
    try {
      const resp = await fn(ctx);
      // HEAD：拿 GET 的結果去掉 body（狀態碼與標頭保留）
      if (request.method === "HEAD") return new Response(null, { status: resp.status, headers: resp.headers });
      return resp;
    } catch (err) {
      // 3) 全域錯誤邊界：未捕捉例外進 errlog，對外只吐通用 500（不外洩堆疊）
      try { exec.waitUntil(reportErrorNow(env, "router", err, { path: url.pathname })); } catch (e) {}
      return json({ error: "internal-error" }, 500);
    }
  }

  // 4) 無匹配 → 靜態資產／SPA fallback
  return env.ASSETS.fetch(request);
}
