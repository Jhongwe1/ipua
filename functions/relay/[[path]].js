// /relay/<管道slug>/<上游路徑…> — API 中轉站的轉發引擎（2026-07-11 上線）。
//
// 會員把 AI 工具的 base URL 換成 https://uaip.cc.cd/relay/<slug>，金鑰填自己的 uak- 金鑰，
// 伺服器驗過會員身分後把驗證換成站長存的上游金鑰、原樣轉發（含串流回應）。
// 例：POST /relay/openai/v1/chat/completions → POST https://api.openai.com/v1/chat/completions
//
// 會員金鑰放哪裡都收（配合各家 SDK 的習慣）：
//   Authorization: Bearer（OpenAI 系）、x-api-key（Anthropic）、x-goog-api-key／?key=（Gemini）
// 只有「已核准」的帳號能用；封鎖／待核准會拿到 403。
import { json } from "../../lib/site.js";
import { memberKeyFrom, userFromKey, hasService } from "../../lib/auth.js";
import { relayPageResponse } from "../../lib/relaypage.js";

// 不轉發給上游的標頭：連線層的、Cloudflare 加的、還有夾帶會員身分的
const DROP = /^(host|cookie|authorization|x-api-key|x-goog-api-key|content-length|connection|keep-alive|transfer-encoding|upgrade|expect|te|accept-encoding|cf-.*|x-forwarded-.*|x-real-ip|true-client-ip|sec-fetch-.*|origin|referer)$/;

function cors(h) {
  h.set("access-control-allow-origin", "*");
  h.set("access-control-expose-headers", "*");
  return h;
}

export async function onRequest(context) {
  const { request, env, params } = context;
  const url = new URL(request.url);

  // 瀏覽器的 CORS 預檢：一律放行（真正的權限在下面驗會員金鑰）
  if (request.method === "OPTIONS") {
    const h = cors(new Headers({
      "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
      "access-control-allow-headers": request.headers.get("access-control-request-headers") || "*",
      "access-control-max-age": "86400"
    }));
    return new Response(null, { status: 204, headers: h });
  }

  const segs = Array.isArray(params.path) ? params.path : (params.path ? [params.path] : []);
  // 這個 catch-all 也接到「/relay」本身（零段落）— 那不是轉發，是會員操作頁。
  // （Pages 的 [[path]] 會蓋掉同層 index.js，所以頁面渲染改由這裡代理。）
  if (!segs.length) {
    if (request.method === "GET" || request.method === "HEAD") return relayPageResponse(env);
    return json({ error: "no-channel", hint: "網址要是 /relay/<管道>/<上游路徑>" }, 404);
  }

  // 1) 驗會員金鑰
  const key = memberKeyFrom(request, url);
  if (!key) return json({ error: "no-key", hint: "請帶你的會員金鑰（uak-…），金鑰在 /relay 頁面產生" }, 401);
  const user = await userFromKey(env, key);
  if (!user) return json({ error: "bad-key", hint: "金鑰無效或已被重新產生 — 到 /relay 看看目前這把" }, 401);
  if (!hasService(user, env, "relay")) {
    return json({ error: "not-approved", hint: "帳號還沒被站長批准使用中轉站，批准後金鑰才會生效" }, 403);
  }

  // 2) 找管道
  const slug = String(segs[0]).toLowerCase();
  let ch = null;
  try {
    ch = await env.DB.prepare("SELECT * FROM relay_channels WHERE slug=?1 AND enabled=1").bind(slug).first();
  } catch (e) {}
  if (!ch) return json({ error: "unknown-channel", hint: "沒有「" + slug + "」這個管道（或已停用）" }, 404);

  // 3) 組上游請求：路徑原樣接上、查詢字串保留（拿掉夾金鑰用的 ?key=）
  url.searchParams.delete("key");
  const qs = url.searchParams.toString();
  // 段落重新編碼（防注入），但保留 Gemini 路徑會用到的 : 與 @（例 models/gemini-2.5-flash:generateContent）
  const enc = function (s) { return encodeURIComponent(s).replace(/%3A/gi, ":").replace(/%40/gi, "@"); };
  const upPath = segs.slice(1).map(enc).join("/");
  const target = ch.base_url + "/" + upPath + (qs ? "?" + qs : "");

  // 上游金鑰要放哪個標頭，看的是「走原生介面還是 OpenAI 相容介面」，不能只看 kind：
  //   Gemini 原生 v1beta/models/…      → x-goog-api-key（多送 Authorization 會被當成 OAuth token 而 401，實測踩過）
  //   Gemini 相容 v1beta/openai/…      → Authorization: Bearer
  //   Anthropic 原生 v1/messages       → x-api-key
  //   Anthropic 相容 v1/chat/completions → Authorization: Bearer
  // 各家的 OpenAI 相容層一律收 Bearer，所以先判斷是不是相容路徑，是的話統一用 Bearer。
  const openaiCompat = /(^|\/)openai(\/|$)/.test(upPath) || /chat\/completions$/.test(upPath);

  const fh = new Headers();
  request.headers.forEach(function (v, k) { if (!DROP.test(k)) fh.set(k, v); });
  if (ch.api_key) {
    if (openaiCompat) fh.set("authorization", "Bearer " + ch.api_key);
    else if (ch.kind === "anthropic") fh.set("x-api-key", ch.api_key);
    else if (ch.kind === "gemini") fh.set("x-goog-api-key", ch.api_key);
    else fh.set("authorization", "Bearer " + ch.api_key);   // openai / custom（含本地 AI 的 OpenAI 相容介面）
  }

  let resp = null;
  try {
    resp = await fetch(target, {
      method: request.method,
      headers: fh,
      body: (request.method === "GET" || request.method === "HEAD") ? undefined : request.body
    });
  } catch (e) {
    return json({ error: "upstream-unreachable", hint: "連不上上游（" + ch.name + "）", detail: String(e && e.message || e) }, 502);
  }

  // 4) 記用量（背景執行，不拖慢回應）
  try {
    context.waitUntil(
      env.DB.prepare("UPDATE users SET relay_calls = relay_calls + 1 WHERE id=?1").bind(user.id).run().catch(function () {})
    );
  } catch (e) {}

  // 5) 原樣回傳（串流直通）。fetch 已解壓縮，所以 content-encoding/length 不能照抄；
  //    上游的 set-cookie 也不該落到會員的瀏覽器。
  const oh = new Headers(resp.headers);
  oh.delete("set-cookie"); oh.delete("content-encoding"); oh.delete("content-length");
  oh.set("cache-control", "no-store");
  cors(oh);
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: oh });
}
