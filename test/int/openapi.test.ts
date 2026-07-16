// OpenAPI 防漂移（v2.0.0 Phase L，ADR-0010）：
// 1) 路由表(src/routes.ts) × 規格(paths) 雙向一一對應（樣式 :x→{x}、*x→{x}）
// 2) 方法對齊：路由掛什麼方法、規格就要寫什麼（ALL＝至少寫一個）
// 3) API.md §2 端點總覽出現的每個 `METHOD /path` 都要在規格裡
// 4) GET /openapi.json 真的能供應規格
import { describe, it, expect } from "vitest";
import { ROUTES } from "../../src/routes.js";
import { OPENAPI } from "../../src/lib/openapi.js";
import { APIDOC } from "../../src/lib/apidoc.js";
import { onRequestGet as openapiGet } from "../../src/routes/openapi.js";
import { makeCtx, ORIGIN } from "../helpers.js";

// 路由樣式 → OpenAPI path："/api/x/:id"→"/api/x/{id}"、"/relay/*path"→"/relay/{path}"、"/"照舊
function toSpecPath(pattern: string): string {
  if (pattern === "/") return "/";
  return pattern
    .split("/")
    .map((seg) => {
      if (seg.charAt(0) === ":") return "{" + seg.slice(1) + "}";
      if (seg.charAt(0) === "*") return "{" + (seg.slice(1) || "path") + "}";
      return seg;
    })
    .join("/");
}

const HTTP_METHODS = ["get", "post", "put", "delete", "patch", "head", "options"];

describe("openapi 防漂移", () => {
  it("路由表與規格 paths 雙向一致", () => {
    const routePaths = new Set(ROUTES.map((r) => toSpecPath(r[0])));
    const specPaths = new Set(Object.keys(OPENAPI.paths));
    const missingInSpec = [...routePaths].filter((p) => !specPaths.has(p));
    const missingInRoutes = [...specPaths].filter((p) => !routePaths.has(p));
    expect(missingInSpec, "路由有、規格沒有（快去補 docs/openapi.yaml）").toEqual([]);
    expect(missingInRoutes, "規格有、路由沒有（幽靈端點）").toEqual([]);
  });

  it("每條路由的方法都寫進規格（ALL＝至少一個）", () => {
    for (const [pattern, handlers] of ROUTES) {
      const spec = OPENAPI.paths[toSpecPath(pattern)];
      const specMethods = Object.keys(spec).filter((k) => HTTP_METHODS.indexOf(k) >= 0);
      if (handlers.ALL) {
        expect(specMethods.length, pattern + " 是 ALL，規格至少要寫一個方法").toBeGreaterThan(0);
        continue;
      }
      for (const m of Object.keys(handlers)) {
        expect(specMethods, pattern + " 缺方法 " + m).toContain(m.toLowerCase());
      }
    }
  });

  it("API.md 端點總覽的每個 `METHOD /path` 都在規格裡", () => {
    // 只掃 §2 端點總覽（到 §3 為止），拿 `GET /api/...` 形式的反引號片段
    const overview = APIDOC.slice(0, APIDOC.indexOf("## 3."));
    const re = /`(GET|POST|PUT|DELETE)\s+(\/[^\s`]*)`/g;
    let m: RegExpExecArray | null;
    const misses: string[] = [];
    while ((m = re.exec(overview))) {
      const method = m[1].toLowerCase();
      const p = m[2]
        .split("?")[0] // `GET /auth/login?next=…` 這種帶查詢字串的寫法只取路徑
        .replace(/\{id或slug\}/g, "{key}"); // API.md 的人話寫法 → 規格參數名
      const entry = OPENAPI.paths[p];
      if (!entry || !entry[method]) misses.push(m[1] + " " + p);
    }
    expect(misses, "API.md 有寫、openapi.yaml 沒有").toEqual([]);
  });

  it("GET /openapi.json 供應規格", async () => {
    const r = openapiGet(makeCtx({ url: ORIGIN + "/openapi.json" }));
    expect(r.status).toBe(200);
    const j: any = await r.json();
    expect(j.openapi).toBe("3.1.0");
    expect(j.info.title).toContain("uaip");
    expect(Object.keys(j.paths).length).toBeGreaterThan(40);
  });
});
