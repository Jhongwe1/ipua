// lib/playground.js — LLM Playground（/playground）的伺服器共用邏輯。
// 頁面本體在 lib/playgroundpage.js；API 端點在 functions/api/playground/*。
//
// 設計重點：
//   1. 瀏覽器端不經手任何金鑰 — 聊天請求帶登入 cookie 打 /api/playground/chat，
//      伺服器查渠道（relay_channels）、帶上游金鑰去打，會員永遠看不到上游。
//   2. 三種上游（openai 相容／anthropic／gemini 原生）各自轉換請求與串流格式，
//      對瀏覽器統一輸出一種極簡 SSE：{conv}→{d:"文字"}…→{done}（出錯：{error,hint}）。
//   3. 站長／agent 可用 Authorization: Bearer <LOGS_TOKEN> 直接測（身分算站長帳號）。
import { json } from "./site.js";
import { getSessionUser, goodOrigin, hasService, adminEmails, isLocal } from "./auth.js";

export const PG_LIMITS = {
  maxMsgs: 80,        // 一次請求最多帶的訊息數（前端會自己修剪，這是硬上限）
  maxChars: 100000,   // 單則訊息字數上限
  maxTotal: 300000,   // 整包訊息字數上限
  maxTokens: 4096     // anthropic 必填 max_tokens；取各型號都安全的值
};

// 驗證來訪者：登入 cookie（一般會員，寫入類請求過 Origin 檢查）
// 或 Authorization: Bearer LOGS_TOKEN（站長金鑰 → 以站長帳號的身分操作，方便 curl／agent 測試）。
// 回 { user } 或 { err: Response }。
export async function pgUser(request, env, url) {
  const auth = request.headers.get("authorization") || "";
  const token = auth.indexOf("Bearer ") === 0 ? auth.slice(7).trim() : "";
  const tokenOk = env.LOGS_TOKEN ? (token && token === env.LOGS_TOKEN) : (!!token && isLocal(url));
  if (tokenOk) {
    const em = adminEmails(env)[0] || "";
    const u = await env.DB.prepare("SELECT * FROM users WHERE lower(email)=?1 ORDER BY is_admin DESC, id LIMIT 1")
      .bind(em).first();
    if (u) return { user: u };
    return { err: json({ error: "no-admin-user", hint: "管理金鑰要掛在站長帳號上 — 請先用站長信箱登入網站一次" }, 401) };
  }
  const user = await getSessionUser(request, env);
  if (!user) return { err: json({ error: "unauthorized", hint: "請先登入" }, 401) };
  if (request.method !== "GET" && !goodOrigin(request, url)) {
    return { err: json({ error: "bad-origin" }, 403) };
  }
  if (!hasService(user, env, "playground")) {
    return { err: json({ error: "not-approved", hint: "此服務需要站長批准後才能使用" }, 403) };
  }
  return { user };
}

// 整理聊天請求本體 → { convId, channel, model, messages } 或 { err }
export function cleanChat(b) {
  if (!b || typeof b !== "object") return { err: "需要 JSON 本體" };
  const channel = String(b.channel || "").trim().toLowerCase();
  const model = String(b.model || "").trim();
  if (!channel || !model) return { err: "要指定 channel 與 model" };
  if (!Array.isArray(b.messages) || !b.messages.length) return { err: "messages 不能是空的" };
  if (b.messages.length > PG_LIMITS.maxMsgs) return { err: "訊息太多（上限 " + PG_LIMITS.maxMsgs + " 則）" };
  const messages = [];
  let total = 0;
  for (let i = 0; i < b.messages.length; i++) {
    const m = b.messages[i] || {};
    const role = m.role === "assistant" ? "assistant" : m.role === "system" ? "system" : m.role === "user" ? "user" : null;
    if (!role) return { err: "role 只能是 user / assistant / system" };
    const content = String(m.content == null ? "" : m.content);
    if (!content.trim()) continue;
    if (content.length > PG_LIMITS.maxChars) return { err: "有訊息超過單則字數上限" };
    total += content.length;
    if (total > PG_LIMITS.maxTotal) return { err: "對話內容太長，開個新對話吧" };
    messages.push({ role: role, content: content });
  }
  if (!messages.length) return { err: "messages 不能是空的" };
  if (messages[messages.length - 1].role !== "user") return { err: "最後一則要是 user 訊息" };
  const convId = parseInt(b.conv_id, 10);
  return { convId: convId > 0 ? convId : null, channel: channel, model: model, messages: messages };
}

// 把統一格式的 messages 轉成各家上游的串流請求 → { url, headers, body }
export function buildUpstream(ch, model, messages) {
  const sys = messages.filter(function (m) { return m.role === "system"; })
    .map(function (m) { return m.content; }).join("\n\n");
  const rest = messages.filter(function (m) { return m.role !== "system"; });

  if (ch.kind === "anthropic") {
    return {
      url: ch.base_url + "/v1/messages",
      headers: { "content-type": "application/json", "x-api-key": ch.api_key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: model, max_tokens: PG_LIMITS.maxTokens, stream: true,
        system: sys || undefined,
        messages: rest.map(function (m) { return { role: m.role, content: m.content }; })
      })
    };
  }
  if (ch.kind === "gemini") {
    // Gemini 原生端點；金鑰只走 x-goog-api-key（多送 Authorization 會 401，中轉那邊實測過）
    const enc = encodeURIComponent(model).replace(/%2F/gi, "/");
    return {
      url: ch.base_url + "/v1beta/models/" + enc + ":streamGenerateContent?alt=sse",
      headers: { "content-type": "application/json", "x-goog-api-key": ch.api_key },
      body: JSON.stringify({
        contents: rest.map(function (m) {
          return { role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] };
        }),
        systemInstruction: sys ? { parts: [{ text: sys }] } : undefined
      })
    };
  }
  // openai / custom：OpenAI 相容介面（system 直接留在 messages 裡）
  return {
    url: ch.base_url + "/v1/chat/completions",
    headers: { "content-type": "application/json", "authorization": "Bearer " + ch.api_key },
    body: JSON.stringify({ model: model, stream: true, messages: messages })
  };
}

// 從上游 SSE 的一筆 JSON 取出增量文字；上游夾帶錯誤時丟 Error
export function extractDelta(kind, j) {
  if (kind === "anthropic") {
    if (j.type === "error") throw new Error((j.error && j.error.message) || "upstream error");
    if (j.type === "content_block_delta" && j.delta && typeof j.delta.text === "string") return j.delta.text;
    return "";
  }
  if (kind === "gemini") {
    if (j.error) throw new Error(j.error.message || "upstream error");
    let out = "";
    const parts = (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [];
    for (let i = 0; i < parts.length; i++) if (typeof parts[i].text === "string") out += parts[i].text;
    return out;
  }
  if (j.error) throw new Error((j.error && j.error.message) || String(j.error));
  const d = j.choices && j.choices[0] && j.choices[0].delta;
  return (d && typeof d.content === "string") ? d.content : "";
}

// 上游不支援串流、直接回一整包 JSON 時的取文字（備援路徑）
export function extractFull(kind, j) {
  try {
    if (kind === "anthropic") {
      return (j.content || []).map(function (c) { return c && c.text || ""; }).join("");
    }
    if (kind === "gemini") {
      const parts = (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [];
      return parts.map(function (p) { return p && p.text || ""; }).join("");
    }
    return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "";
  } catch (e) { return ""; }
}

// relay_channels.models（逗號分隔）→ 陣列
export function chModels(ch) {
  return String(ch && ch.models || "").split(",").map(function (s) { return s.trim(); }).filter(Boolean);
}
