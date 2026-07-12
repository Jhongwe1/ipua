// GET /vpn/sub/<token> — VPN 訂閱鏡像端點（給 Clash／v2rayN 等 App 直接訂閱）。
// token 就是驗證本身（等於會員的訂閱網址），不需要登入 cookie，方便 App 定時更新。
//
// 2026-07-12 多渠道化：上游來源存 vpn_channels 表（站長在 /vpn 頁管理），
// 這裡把「所有啟用中渠道」合併成一份訂閱回給會員 — 會員看不到渠道存在與上游網址。
//
// 合併規則（按渠道數自動選最相容的做法）：
//   只有手動節點渠道        → 直接回標準 base64 節點清單。
//   恰好一個訂閱渠道        → 透傳會員 App 的 UA 去抓（機場靠 UA 決定回 YAML 或 base64），
//                             原樣轉發；流量／到期（Subscription-Userinfo）照傳；
//                             上游是 base64 時把手動節點解碼附加再編碼。
//   兩個以上訂閱渠道        → 各自用 base64 相容的 UA（v2rayN）去抓、解碼、合併全部節點
//                             ＋手動節點，去重後回一份 base64 訂閱（Clash YAML 沒法安全合併，
//                             解不開的渠道略過）。多渠道時流量資訊無法合併，不回傳。
// 上游抓取都掛邊緣快取 5 分鐘，會員再多也不會打爆機場。

function textResp(body, status, extraHeaders) {
  const h = Object.assign({
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store"
  }, extraHeaders || {});
  return new Response(body, { status: status || 200, headers: h });
}

// base64（可能有 URL-safe 變體）→ 文字；失敗回 null
function b64decode(s) {
  try {
    const t = s.replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, "");
    const pad = t + "===".slice((t.length + 3) % 4);
    const bin = atob(pad);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch (e) { return null; }
}
function b64encode(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

// 一段文字 → 節點連結陣列（vmess:// vless:// trojan:// ss:// …）；不是節點清單回空陣列
function nodeLines(text) {
  if (!text) return [];
  return text.split(/\r?\n/).map(function (s) { return s.trim(); })
    .filter(function (s) { return /^[a-z][a-z0-9+.-]*:\/\//i.test(s); });
}

// 抓一個上游訂閱 → 回節點連結陣列（base64 或純文字清單都收；YAML 等解不開回 null）
async function fetchNodes(url, ua) {
  let up = null;
  try {
    up = await fetch(url, {
      headers: { "user-agent": ua },
      cf: { cacheTtl: 300, cacheEverything: true }
    });
  } catch (e) { return null; }
  if (!up.ok) return null;
  const raw = (await up.text()).trim();
  const decoded = b64decode(raw);
  let lines = nodeLines(decoded);
  if (!lines.length) lines = nodeLines(raw);   // 有些來源直接回純文字清單
  return lines.length ? lines : null;
}

export async function onRequestGet(context) {
  const { request, env, params } = context;
  const token = String(params.token || "");
  if (!/^uvt[a-z2-7]{10,40}$/.test(token)) return textResp("invalid token", 404);
  if (!env.DB) return textResp("service unavailable", 503);

  // 驗 token → 會員
  let user = null;
  try {
    user = await env.DB.prepare("SELECT id,status,is_admin FROM users WHERE vpn_token=?1").bind(token).first();
  } catch (e) {}
  if (!user) return textResp("invalid token", 404);
  if (user.status === "blocked") return textResp("account blocked", 403);
  if (user.status !== "approved" && user.is_admin !== 1) return textResp("account not approved yet", 403);

  // 啟用中的渠道
  let channels = [];
  try {
    const res = await env.DB.prepare("SELECT * FROM vpn_channels WHERE enabled=1 ORDER BY id").all();
    channels = res.results || [];
  } catch (e) {}

  const manual = [];
  const subs = [];
  channels.forEach(function (c) {
    if (c.kind === "nodes") nodeLines(c.nodes).forEach(function (l) { manual.push(l); });
    else if (c.url) subs.push(c);
  });

  // 記一次抓取（背景執行，不拖慢訂閱更新）
  try {
    context.waitUntil(
      env.DB.prepare("UPDATE users SET vpn_pulls = vpn_pulls + 1 WHERE id=?1").bind(user.id).run().catch(function () {})
    );
  } catch (e) {}

  // 沒有任何訂閱渠道：只回手動節點（也沒有 → 站長還沒設定）
  if (!subs.length) {
    if (!manual.length) return textResp("no subscription configured", 404);
    return textResp(b64encode(dedupe(manual).join("\n")), 200, { "profile-update-interval": "12" });
  }

  // 恰好一個訂閱渠道：透傳會員 App 的 UA（機場靠 UA 回不同格式），行為與單一來源時代相同
  if (subs.length === 1) {
    let up = null;
    try {
      up = await fetch(subs[0].url, {
        headers: { "user-agent": request.headers.get("user-agent") || "clash" },
        cf: { cacheTtl: 300, cacheEverything: true }
      });
    } catch (e) {
      return textResp("upstream unreachable", 502);
    }
    if (!up.ok) return textResp("upstream error " + up.status, 502);

    const raw = await up.text();
    const passHeaders = {};
    const ui = up.headers.get("subscription-userinfo");
    if (ui) passHeaders["subscription-userinfo"] = ui;
    passHeaders["profile-update-interval"] = up.headers.get("profile-update-interval") || "12";
    const ct = up.headers.get("content-type");
    if (ct) passHeaders["content-type"] = ct;

    if (!manual.length) return textResp(raw, 200, passHeaders);

    // 手動節點只有在「上游是標準 base64 節點清單」時安全附加（YAML/其他格式不動，以免弄壞）
    const decoded = b64decode(raw.trim());
    if (decoded && nodeLines(decoded).length) {
      const merged = dedupe(nodeLines(decoded).concat(manual));
      delete passHeaders["content-type"];   // 重新編碼後就是純 base64 訂閱
      return textResp(b64encode(merged.join("\n")), 200, passHeaders);
    }
    return textResp(raw, 200, passHeaders);
  }

  // 兩個以上訂閱渠道：並行抓、解碼、合併（解不開的略過，全部失敗才報錯）
  const results = await Promise.all(subs.map(function (c) { return fetchNodes(c.url, "v2rayN/6.60"); }));
  let all = [];
  let okCount = 0;
  results.forEach(function (lines) {
    if (lines) { okCount++; all = all.concat(lines); }
  });
  all = all.concat(manual);
  if (!okCount && !manual.length) return textResp("all upstreams unreachable", 502);
  if (!all.length) return textResp("no nodes available", 502);
  return textResp(b64encode(dedupe(all).join("\n")), 200, { "profile-update-interval": "12" });
}

function dedupe(arr) {
  const seen = {};
  return arr.filter(function (s) {
    if (seen[s]) return false;
    seen[s] = 1;
    return true;
  });
}
