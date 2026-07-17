// GET /api/whoami — 由本站的 Cloudflare 邊緣節點回報「伺服端看到的請求資訊」。
// 同源 API：只要頁面打得開，這支就一定通，不再依賴 httpbin.org 等第三方服務。
// request.cf 的地理欄位來自 Cloudflare 內建的 IP 定位資料，所有方案皆可用。
import type { RouteCtx } from "../../types.js";

export function onRequestGet({ request }: RouteCtx): Response {
  const h = request.headers;
  // cf 欄位依方案／環境可有可無，逐欄防禦式取值

  const cf = (request.cf || {}) as any;
  const num = (v: any): number | null => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  };
  const body = {
    ip: h.get("cf-connecting-ip") || "",
    ua: h.get("user-agent") || "",
    lang: h.get("accept-language") || "",
    country: cf.country || "",
    city: cf.city || "",
    region: cf.region || "",
    region_code: cf.regionCode || "",
    postal: cf.postalCode || "",
    latitude: num(cf.latitude),
    longitude: num(cf.longitude),
    timezone: cf.timezone || "",
    asn: cf.asn || null,
    isp: cf.asOrganization || "",
    colo: cf.colo || "",
    http: cf.httpProtocol || "",
    tls: cf.tlsVersion || ""
  };
  return new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*"
    }
  });
}
