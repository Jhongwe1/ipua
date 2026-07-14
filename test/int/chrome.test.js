// Phase F VPN 隱形：filterMenu 純函式、getChromeFor 四種身分、/vpn 頁的 ASSETS 偽裝。
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { filterMenu, getChromeFor, canSeeVpn } from "../../lib/chrome.js";
import { onRequestGet as vpnPage } from "../../functions/vpn/index.js";
import { onRequestGet as meGet } from "../../functions/api/me.js";
import { DEFAULT_MENU } from "../../lib/site.js";
import { createSession } from "../../lib/auth.js";
import { makeCtx, seedUser, seedAdmin, envWith, ORIGIN } from "../helpers.js";

async function reqAs(user, path) {
  const headers = {};
  if (user) {
    const s = await createSession(env, user, new URL(ORIGIN + "/"));
    headers.cookie = "ipua_sess=" + s.sid;
  }
  return new Request(ORIGIN + (path || "/"), { headers });
}

describe("filterMenu（純函式）", () => {
  const menu = [
    { kind: "section", label: "服務", url: "" },
    { kind: "link", label: "VPN", url: "/vpn" },
    { kind: "link", label: "VPN 教學", url: "/vpn/howto" },
    { kind: "link", label: "中轉", url: "/relay" },
    { kind: "link", label: "特價 vpn 文章", url: "/articles/9" }   // 標籤含 vpn 但網址不是 → 不濾
  ];
  it("showVpn=false：/vpn 與 /vpn/ 開頭的項目消失，其餘原樣", () => {
    const out = filterMenu(menu, false);
    expect(out.map((i) => i.url)).toEqual(["", "/relay", "/articles/9"]);
  });
  it("showVpn=true：一項都不動", () => {
    expect(filterMenu(menu, true)).toEqual(menu);
  });
  it("內建預設選單也適用", () => {
    const out = filterMenu(DEFAULT_MENU, false);
    expect(out.some((i) => i.url === "/vpn")).toBe(false);
    expect(out.some((i) => i.url === "/relay")).toBe(true);
  });
});

describe("getChromeFor 四種身分", () => {
  it("匿名：無 VPN 項、user=null", async () => {
    const r = await getChromeFor(env, await reqAs(null));
    expect(r.user).toBeNull();
    expect(r.chrome.menu.some((i) => i.url === "/vpn")).toBe(false);
    expect(r.chrome.brand).toBeTruthy();
  });
  it("pending 會員：無 VPN 項", async () => {
    const u = await seedUser({ status: "pending" });
    const r = await getChromeFor(env, await reqAs(u));
    expect(r.user.id).toBe(u.id);
    expect(r.chrome.menu.some((i) => i.url === "/vpn")).toBe(false);
  });
  it("approved 但沒 vpn 服務：無 VPN 項；有 vpn 服務：看得到", async () => {
    const noVpn = await seedUser({ status: "approved", services: "relay,playground" });
    expect((await getChromeFor(env, await reqAs(noVpn))).chrome.menu.some((i) => i.url === "/vpn")).toBe(false);
    const withVpn = await seedUser({ status: "approved", services: "vpn" });
    expect((await getChromeFor(env, await reqAs(withVpn))).chrome.menu.some((i) => i.url === "/vpn")).toBe(true);
  });
  it("站長：看得到（不看 services 欄）", async () => {
    const adm = await seedAdmin();
    expect((await getChromeFor(env, await reqAs(adm))).chrome.menu.some((i) => i.url === "/vpn")).toBe(true);
    expect(canSeeVpn(adm, env)).toBe(true);
  });
});

describe("/vpn 頁隱形（stub env.ASSETS）", () => {
  const SPA = "<!doctype html><title>SPA</title>假裝是 index.html";
  const envAssets = () => envWith({
    ASSETS: { fetch: async () => new Response(SPA, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }) }
  });

  async function hit(user) {
    const headers = {};
    if (user) {
      const s = await createSession(env, user, new URL(ORIGIN + "/"));
      headers.cookie = "ipua_sess=" + s.sid;
    }
    return vpnPage(makeCtx({ url: ORIGIN + "/vpn", init: { headers }, env: envAssets() }));
  }

  it("匿名／pending／沒 vpn 服務 → 200 靜態 SPA（與不存在的路徑無異）", async () => {
    for (const user of [null, await seedUser({ status: "pending" }),
                        await seedUser({ status: "approved", services: "relay" })]) {
      const r = await hit(user);
      expect(r.status).toBe(200);
      expect(await r.text()).toBe(SPA);                     // 拿到的是 SPA 殼，不是 VPN 頁
    }
  });
  it("有 vpn 服務的會員與站長 → 真的 VPN 頁", async () => {
    for (const user of [await seedUser({ status: "approved", services: "vpn" }), await seedAdmin()]) {
      const r = await hit(user);
      expect(r.status).toBe(200);
      const text = await r.text();
      expect(text).toContain("VPN");
      expect(text).not.toBe(SPA);
      expect(r.headers.get("content-security-policy")).toContain("nonce-");   // 走 html() 出口
    }
  });
});

describe("/api/me 的 vpn 欄位省略矩陣", () => {
  async function meFor(user) {
    const headers = {};
    const s = await createSession(env, user, new URL(ORIGIN + "/"));
    headers.cookie = "ipua_sess=" + s.sid;
    return (await meGet(makeCtx({ url: ORIGIN + "/api/me", init: { headers } }))).json();
  }
  it("沒 vpn 權限：vpn_token / vpn_pulls 連鍵都沒有", async () => {
    const u = await seedUser({ status: "approved", services: "relay", vpn_token: "uvt" + "z".repeat(20) });
    const j = await meFor(u);
    expect("vpn_token" in j.user).toBe(false);
    expect("vpn_pulls" in j.user).toBe(false);
    expect(j.user.services).toEqual(["relay"]);
  });
  it("有 vpn 權限／站長：欄位照給", async () => {
    const u = await seedUser({ status: "approved", services: "vpn", vpn_token: "uvt" + "y".repeat(20) });
    const j = await meFor(u);
    expect(j.user.vpn_token).toBe("uvt" + "y".repeat(20));
    expect(j.user.vpn_pulls).toBe(0);
    const adm = await seedAdmin({ vpn_token: "uvt" + "x".repeat(20) });
    const ja = await meFor(adm);
    expect(ja.user.vpn_token).toBe("uvt" + "x".repeat(20));
  });
});
