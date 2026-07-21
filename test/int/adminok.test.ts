// adminOk（管理員驗證，兩種身分都收）矩陣：
// Bearer 對/錯/缺 × LOGS_TOKEN 有/無、管理員 cookie、跨站 Origin 拒斥。
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { adminOk, createSession } from "../../src/lib/auth.js";
import { seedUser, seedAdmin, envWith, ORIGIN } from "../helpers.js";

const URL_ = new URL(ORIGIN + "/api/admin/x");
const req = (headers?: Record<string, string>) =>
  new Request(ORIGIN + "/api/admin/x", { headers: headers || {} });

describe("adminOk × LOGS_TOKEN 已設定", () => {
  const e = () => envWith({ LOGS_TOKEN: "sekret-token" });

  it("Bearer 正確 → 放行", async () => {
    expect(await adminOk(req({ authorization: "Bearer sekret-token" }), e(), URL_)).toBe(true);
  });
  it("Bearer 錯誤／缺 → 沒 session 就擋", async () => {
    expect(await adminOk(req({ authorization: "Bearer wrong" }), e(), URL_)).toBe(false);
    expect(await adminOk(req(), e(), URL_)).toBe(false);
  });
  it("管理員 cookie → 放行；一般會員 cookie → 擋", async () => {
    const adm = await seedAdmin();
    const sa = await createSession(env, adm, URL_);
    expect(await adminOk(req({ cookie: "ipua_sess=" + sa.sid }), e(), URL_)).toBe(true);

    const mem = await seedUser({ status: "approved" });
    const sm = await createSession(env, mem, URL_);
    expect(await adminOk(req({ cookie: "ipua_sess=" + sm.sid }), e(), URL_)).toBe(false);
  });
  it("管理員 cookie＋跨站 Origin → 擋（CSRF）", async () => {
    const adm = await seedAdmin();
    const sa = await createSession(env, adm, URL_);
    expect(await adminOk(req({ cookie: "ipua_sess=" + sa.sid, origin: "https://evil.com" }), e(), URL_)).toBe(
      false
    );
  });
});

describe("adminOk × LOGS_TOKEN 未設定", () => {
  const local = new URL("http://localhost:8788/api/admin/x");

  it("開發旗標 DEV_UNSAFE_ADMIN='1' → 免驗放行（本機開發）", async () => {
    expect(await adminOk(new Request(local), envWith({ DEV_UNSAFE_ADMIN: "1" }), local)).toBe(true);
  });

  // 2026-07-22：這條原本是「localhost 免驗放行」，判斷依據是 url.hostname —— 而 Workers 的
  // request.url 的 host 來自 **Host 標頭，客戶端可控**。正式站因為有設 LOGS_TOKEN、
  // 且 Cloudflare 按 Host/SNI 路由所以打不到，但形狀是錯的：授權決策的輸入來自請求本身，
  // 而且 LOGS_TOKEN 忘了設就往「開」的方向倒。改成明示的環境旗標之後，Host 說什麼都沒用。
  it("沒有開發旗標 → Host 說自己是 localhost 也不放行（授權不看客戶端可控的標頭）", async () => {
    expect(await adminOk(new Request(local), envWith({}), local)).toBe(false);
    const loop = new URL("http://127.0.0.1/api/admin/x");
    expect(await adminOk(new Request(loop), envWith({}), loop)).toBe(false);
  });

  it("旗標是空字串／其他值 → 一律關（只認 '1'）", async () => {
    expect(await adminOk(new Request(local), envWith({ DEV_UNSAFE_ADMIN: "" }), local)).toBe(false);
    expect(await adminOk(new Request(local), envWith({ DEV_UNSAFE_ADMIN: "true" }), local)).toBe(false);
    expect(await adminOk(new Request(local), envWith({ DEV_UNSAFE_ADMIN: "0" }), local)).toBe(false);
  });

  it("有設 LOGS_TOKEN 時，開發旗標不構成繞道（金鑰錯就是錯）", async () => {
    const e = envWith({ LOGS_TOKEN: "sekret-token", DEV_UNSAFE_ADMIN: "1" });
    expect(await adminOk(new Request(local, { headers: { authorization: "Bearer wrong" } }), e, local)).toBe(
      false
    );
    expect(await adminOk(new Request(local), e, local)).toBe(false);
  });
  it("正式站沒 token 沒 session → 擋", async () => {
    expect(await adminOk(req(), envWith({}), URL_)).toBe(false);
  });
  it("正式站沒 token 但管理員 cookie 還是能用", async () => {
    const adm = await seedAdmin();
    const sa = await createSession(env, adm, URL_);
    expect(await adminOk(req({ cookie: "ipua_sess=" + sa.sid }), envWith({}), URL_)).toBe(true);
  });
});
