// lib/site.js 純函式（esc／json／fmtDate）＋ html() 的 CSP nonce 蓋章。
import { describe, it, expect } from "vitest";
import { esc, json, fmtDate, html } from "../../lib/site.js";

describe("esc（HTML 跳脫）", () => {
  it("五個危險字元全跳", () => {
    expect(esc(`<a href="x" onclick='y'>&</a>`))
      .toBe("&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;");
  });
  it("null / undefined → 空字串；數字轉字串", () => {
    expect(esc(null)).toBe("");
    expect(esc(undefined)).toBe("");
    expect(esc(42)).toBe("42");
  });
});

describe("json（API 回應工具）", () => {
  it("預設 200、JSON content-type、no-store", async () => {
    const r = json({ ok: true });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("application/json");
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(await r.json()).toEqual({ ok: true });
  });
  it("自訂狀態碼", () => {
    expect(json({ error: "x" }, 403).status).toBe(403);
  });
});

describe("html（SSR 單一入口：CSP nonce 蓋章）", () => {
  it("每個 <script 標籤都被蓋上同一顆 nonce，且 CSP 標頭引用它", async () => {
    const body = "<html><head><script>var a=1;</script></head>" +
      '<body><script src="/assets/x.js"></script><p>&lt;script&gt; 這是跳脫過的字不該被蓋</p></body></html>';
    const r = html(body);
    const csp = r.headers.get("content-security-policy");
    const m = csp.match(/'nonce-([^']+)'/);
    expect(m).toBeTruthy();
    const text = await r.text();
    const stamped = text.match(/<script nonce="([^"]+)"/g) || [];
    expect(stamped.length).toBe(2);                            // 兩個 script 都蓋到
    expect(text).toContain('<script nonce="' + m[1] + '">');   // nonce 與標頭一致
    expect(text).toContain("&lt;script&gt;");                  // 跳脫內容不受影響
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("report-uri /api/csp-report");
    expect(r.headers.get("strict-transport-security")).toContain("max-age=");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
  });
  it("兩次呼叫 nonce 不同（per-request）", async () => {
    const n = (r) => r.headers.get("content-security-policy").match(/'nonce-([^']+)'/)[1];
    expect(n(html("<p>a</p>"))).not.toBe(n(html("<p>a</p>")));
  });
});

describe("fmtDate（UTC ISO → 台灣日期）", () => {
  it("UTC+8 換日邊界", () => {
    expect(fmtDate("2026-07-14T15:59:00Z")).toBe("2026-07-14");
    expect(fmtDate("2026-07-14T16:00:00Z")).toBe("2026-07-15");
  });
  it("壞輸入回空字串", () => {
    expect(fmtDate("not-a-date")).toBe("");
    expect(fmtDate("")).toBe("");
  });
});
