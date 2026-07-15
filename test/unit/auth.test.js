// lib/auth.js 純函式的行為快照 — 這些是全站安全邊界的地基。
import { describe, it, expect } from "vitest";
import {
  randToken, sha256hex, keyHint, safeNext, goodOrigin, userServices, memberKeyFrom
} from "../../lib/auth.js";

describe("randToken", () => {
  it("前綴＋預設 26 字、只用小寫 base32（a-z2-7）", () => {
    const t = randToken("uak-");
    expect(t).toMatch(/^uak-[a-z2-7]{26}$/);
  });
  it("自訂長度", () => {
    expect(randToken("", 32)).toMatch(/^[a-z2-7]{32}$/);
    expect(randToken("uvt", 20)).toMatch(/^uvt[a-z2-7]{20}$/);
  });
  it("兩次產生不相同", () => {
    expect(randToken("x", 26)).not.toBe(randToken("x", 26));
  });
});

describe("sha256hex", () => {
  it("已知向量：sha256('abc')", async () => {
    expect(await sha256hex("abc"))
      .toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
  it("空字串也有定義", async () => {
    expect(await sha256hex(""))
      .toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});

describe("keyHint", () => {
  it("短金鑰（<12 字）原樣", () => {
    expect(keyHint("short")).toBe("short");
  });
  it("長金鑰只露頭 8 尾 4", () => {
    expect(keyHint("uak-abcdefghijklmnopqrstuvwxyz")).toBe("uak-abcd…wxyz");
  });
  it("空值回空字串", () => {
    expect(keyHint(null)).toBe("");
  });
});

describe("safeNext（登入後跳轉只收站內路徑）", () => {
  it("正常站內路徑放行", () => {
    expect(safeNext("/relay")).toBe("/relay");
    expect(safeNext("/p/about?x=1")).toBe("/p/about?x=1");
  });
  it("協定相對網址 //evil.com 擋下（重點案例）", () => {
    expect(safeNext("//evil.com")).toBe("/");
  });
  it("絕對網址、空值、非 / 開頭都退回 /", () => {
    expect(safeNext("https://evil.com")).toBe("/");
    expect(safeNext("")).toBe("/");
    expect(safeNext("relay")).toBe("/");
    expect(safeNext(null)).toBe("/");
  });
  it("超長路徑截斷到 300 字", () => {
    expect(safeNext("/" + "a".repeat(500)).length).toBe(300);
  });
});

describe("goodOrigin（CSRF 防線）矩陣", () => {
  const url = new URL("https://uaip.cc.cd/api/x");
  const req = (origin) => new Request("https://uaip.cc.cd/api/x", {
    headers: origin == null ? {} : { origin }
  });
  it("沒有 Origin（curl、同站導覽）放行", () => {
    expect(goodOrigin(req(null), url)).toBe(true);
  });
  it("Origin: null（沙盒 iframe）擋", () => {
    expect(goodOrigin(req("null"), url)).toBe(false);
  });
  it("同源放行", () => {
    expect(goodOrigin(req("https://uaip.cc.cd"), url)).toBe(true);
  });
  it("env.SITE_ORIGIN（正式網址）跨源放行 — 例如從預覽域打正式 API", () => {
    const u2 = new URL("https://uaip.pages.dev/api/x");
    const r2 = new Request("https://uaip.pages.dev/api/x", { headers: { origin: "https://uaip.cc.cd" } });
    expect(goodOrigin(r2, u2, { SITE_ORIGIN: "https://uaip.cc.cd" })).toBe(true);
    expect(goodOrigin(r2, u2, {})).toBe(false);   // 沒設 SITE_ORIGIN 就不放行
  });
  it("localhost 開發放行", () => {
    expect(goodOrigin(req("http://localhost:8788"), url)).toBe(true);
    expect(goodOrigin(req("http://127.0.0.1:8788"), url)).toBe(true);
  });
  it("外站一律擋", () => {
    expect(goodOrigin(req("https://evil.com"), url)).toBe(false);
    expect(goodOrigin(req("https://uaip.cc.cd.evil.com"), url)).toBe(false);
  });
});

describe("userServices（分服務批准）矩陣", () => {
  const env = { ADMIN_EMAILS: "admin@example.com" };
  it("null／封鎖 → 空清單", () => {
    expect(userServices(null, env)).toEqual([]);
    expect(userServices({ status: "blocked", is_admin: 1, services: "relay" }, env)).toEqual([]);
  });
  it("站長（is_admin=1）→ 全部服務，不看 services 欄", () => {
    expect(userServices({ status: "approved", is_admin: 1, services: "" }, env))
      .toEqual(["relay", "vpn", "playground"]);
  });
  it("ADMIN_EMAILS 名單內的信箱（未設 is_admin）也算站長", () => {
    expect(userServices({ status: "approved", is_admin: 0, email: "admin@example.com", services: "" }, env))
      .toEqual(["relay", "vpn", "playground"]);
  });
  it("pending → 空清單（就算 services 有值）", () => {
    expect(userServices({ status: "pending", is_admin: 0, services: "relay,vpn" }, env)).toEqual([]);
  });
  it("approved → 只回被批准的合法服務（含去雜、保持標準順序）", () => {
    expect(userServices({ status: "approved", is_admin: 0, services: "vpn , relay" }, env))
      .toEqual(["relay", "vpn"]);
    expect(userServices({ status: "approved", is_admin: 0, services: "bogus,relay" }, env))
      .toEqual(["relay"]);
    expect(userServices({ status: "approved", is_admin: 0, services: "" }, env)).toEqual([]);
  });
});

describe("memberKeyFrom（會員金鑰四種擺法）", () => {
  const url = new URL("https://uaip.cc.cd/relay/x/v1/models");
  it("Authorization: Bearer（OpenAI 系）", () => {
    const r = new Request(url, { headers: { authorization: "Bearer uak-aaa" } });
    expect(memberKeyFrom(r, url)).toBe("uak-aaa");
  });
  it("x-api-key（Anthropic）", () => {
    const r = new Request(url, { headers: { "x-api-key": "uak-bbb" } });
    expect(memberKeyFrom(r, url)).toBe("uak-bbb");
  });
  it("x-goog-api-key（Gemini）", () => {
    const r = new Request(url, { headers: { "x-goog-api-key": "uak-ccc" } });
    expect(memberKeyFrom(r, url)).toBe("uak-ccc");
  });
  it("?key=（Gemini 舊式）", () => {
    const u2 = new URL("https://uaip.cc.cd/relay/x/v1/models?key=uak-ddd");
    const r = new Request(u2);
    expect(memberKeyFrom(r, u2)).toBe("uak-ddd");
  });
  it("Bearer 優先於其他位置", () => {
    const r = new Request(url, { headers: { authorization: "Bearer uak-1st", "x-api-key": "uak-2nd" } });
    expect(memberKeyFrom(r, url)).toBe("uak-1st");
  });
  it("什麼都沒帶 → 空字串", () => {
    expect(memberKeyFrom(new Request(url), url)).toBe("");
  });
});
