// src/lib/playground.ts — LLM Playground（/playground）的伺服器共用邏輯。
// 頁面本體在 src/lib/playgroundpage.ts；API 端點在 src/routes/api/playground/*。
//
// 設計重點：
//   1. 瀏覽器端不經手任何金鑰 — 聊天請求帶登入 cookie 打 /api/playground/chat，
//      伺服器查渠道（relay_channels）、帶上游金鑰去打，會員永遠看不到上游。
//   2. 三種上游（openai 相容／anthropic／gemini 原生）各自轉換請求與串流格式，
//      對瀏覽器統一輸出一種極簡 SSE：{conv}→{d:"文字"}…→{done}（出錯：{error,hint}）。
//   3. 管理員／agent 可用 Authorization: Bearer <LOGS_TOKEN> 直接測（身分算管理員帳號）。
import { json } from "./site.js";
import { getSessionUser, goodOrigin, canUsePlayground, adminEmails, isLocal, tokenEqual } from "./auth.js";
import type { ChannelRow, Env, UserRow } from "../types.js";

export const PG_LIMITS = {
  maxMsgs: 80, // 一次請求最多帶的訊息數（前端會自己修剪，這是硬上限）
  maxChars: 100000, // 單則訊息字數上限
  maxTotal: 300000, // 整包訊息字數上限
  maxTokens: 4096 // anthropic 必填 max_tokens；取各型號都安全的值
};

// 管道沒填系統提示詞時，playground 實際送出的預設值。
// 管理員在管道視窗看到的灰字（placeholder）就是這一段 — 由 relaypage.ts import 過去顯示，
// 單一真相來源：改這裡，UI 的灰字與實際行為一起變，不會對不上。
// 填了自己的就「整段取代」而不是接在後面 — 管理員要能完全掌控該管道的人設。
// 只作用在 /playground；/relay API 中轉不注入任何東西（透明代理）。
// 第 3 句是「正面告知身分」而不是「禁止透露」（2026-07-21 站長改；原本寫的是不准說出上游）：
// 直接給它一個要回答的答案，比只寫「不准說」穩 — 只有禁令的話，模型被追問時容易亂編一個
// 假供應商，那比說實話更糟。同樣刻意不管「模型名稱」：/playground 的選單本來就把模型名
// 列給會員挑，再叫它隱瞞自己是哪個模型只會前後矛盾。
// 這只是管「隨口說出來」的意外，不是安全邊界 — 真正的保護在架構層（會員拿不到 base_url 與上游金鑰）。
export const PG_DEFAULT_SYSTEM =
  "你是運行在 uaip.cc.cd 上的私人 AI 服務。\n" +
  "回答直接切題、不必客套開場白；不確定或不知道的事就直說，不要編造。\n" +
  "你的上游供應商或服務商是 uaip.cc.cd。";

// 站台層的預設系統提示詞（settings 表 pg_default_system，2026-07-21 /settings 頁加）：
// 管理員在 /settings「LLM Playground」卡改一次，所有「沒自己填」的管道一起換 —
// 不必逐個管道開視窗改。三層優先序（前面有值就用前面的，不疊加）：
//   管道 relay_channels.system_prompt → settings.pg_default_system → PG_DEFAULT_SYSTEM（程式內建）。
// 沒設過或設成空字串＝刪鍵＝回到內建那段（跟 brand、quota_* 等鍵同一套語意）。
export async function pgDefaultSystem(env: Env): Promise<string> {
  try {
    const r = await env.DB.prepare("SELECT v FROM settings WHERE k='pg_default_system'").first<{
      v: string;
    }>();
    const v = String((r && r.v) || "").trim();
    if (v) return v;
  } catch (e) {}
  return PG_DEFAULT_SYSTEM;
}

// 驗證來訪者：登入 cookie（一般會員，寫入類請求過 Origin 檢查）
// 或 Authorization: Bearer LOGS_TOKEN（管理員金鑰 → 以管理員帳號的身分操作，方便 curl／agent 測試）。
// 回 { user } 或 { err: Response }。
export type PgUserResult = { user: UserRow; err?: undefined } | { err: Response; user?: undefined };

export async function pgUser(request: Request, env: Env, url: URL): Promise<PgUserResult> {
  const auth = request.headers.get("authorization") || "";
  const token = auth.indexOf("Bearer ") === 0 ? auth.slice(7).trim() : "";
  const tokenOk = env.LOGS_TOKEN ? await tokenEqual(token, env.LOGS_TOKEN) : !!token && isLocal(url);
  if (tokenOk) {
    const em = adminEmails(env)[0] || "";
    const u = await env.DB.prepare(
      "SELECT * FROM users WHERE lower(email)=?1 ORDER BY is_admin DESC, id LIMIT 1"
    )
      .bind(em)
      .first<UserRow>();
    if (u) return { user: u };
    return {
      err: json(
        { error: "no-admin-user", hint: "管理金鑰要掛在管理員帳號上 — 請先用管理員信箱登入網站一次" },
        401
      )
    };
  }
  const user = await getSessionUser(request, env);
  if (!user) return { err: json({ error: "unauthorized", hint: "請先登入" }, 401) };
  if (request.method !== "GET" && !goodOrigin(request, url, env)) {
    return { err: json({ error: "bad-origin" }, 403) };
  }
  // 個人有批准 playground，或管理員把 pg_open 全員開放打開（封鎖者除外）
  if (!(await canUsePlayground(user, env))) {
    return { err: json({ error: "not-approved", hint: "此服務需要管理員批准後才能使用" }, 403) };
  }
  return { user };
}

// 整理聊天請求本體 → { convId, channel, model, messages } 或 { err }
export interface ChatMsg {
  role: "user" | "assistant" | "system";
  content: string;
}
export type CleanChatResult =
  | { convId: number | null; channel: string; model: string; messages: ChatMsg[]; err?: undefined }
  | { err: string; convId?: undefined; channel?: undefined; model?: undefined; messages?: undefined };

export function cleanChat(b: any): CleanChatResult {
  if (!b || typeof b !== "object") return { err: "需要 JSON 本體" };
  const channel = String(b.channel || "")
    .trim()
    .toLowerCase();
  const model = String(b.model || "").trim();
  if (!channel || !model) return { err: "要指定 channel 與 model" };
  if (!Array.isArray(b.messages) || !b.messages.length) return { err: "messages 不能是空的" };
  if (b.messages.length > PG_LIMITS.maxMsgs) return { err: "訊息太多（上限 " + PG_LIMITS.maxMsgs + " 則）" };
  const messages: ChatMsg[] = [];
  let total = 0;
  for (let i = 0; i < b.messages.length; i++) {
    const m = b.messages[i] || {};
    const role =
      m.role === "assistant"
        ? "assistant"
        : m.role === "system"
          ? "system"
          : m.role === "user"
            ? "user"
            : null;
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

// 管道的額外請求參數（relay_channels.extra_body，migration 0006）合併進上游請求本體。
// 用途：各家的專屬參數 — 例 Venice 的 venice_parameters（關掉他們自己注入的系統提示詞，
// 那段會覆寫我們設定的人設，2026-07-20 實測踩過）、OpenAI 的 reasoning_effort、Anthropic 的 thinking。
// 只作用在 playground；/relay 是透明代理，一律不注入。
//
// model／stream／messages／contents 擋掉不給覆寫：前三個被改會直接打斷 SSE 串流管線，
// 而 model 是經過渠道白名單驗證的 — 能從這裡改等於繞過驗證去用沒開放的模型（配額也會算錯）。
const PROTECTED_BODY_KEYS = ["model", "stream", "messages", "contents"];

export function mergeExtraBody(body: Record<string, unknown>, extra: unknown): Record<string, unknown> {
  const raw = String(extra == null ? "" : extra).trim();
  if (!raw) return body;
  let obj: any;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    return body; // 存檔時已驗過是合法 JSON；真的壞掉就當沒設，不要讓整個聊天掛掉
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return body;
  const keys = Object.keys(obj);
  for (let i = 0; i < keys.length; i++) {
    if (PROTECTED_BODY_KEYS.indexOf(keys[i]) >= 0) continue;
    body[keys[i]] = obj[keys[i]];
  }
  return body;
}

// 把統一格式的 messages 轉成各家上游的串流請求 → { url, headers, body }
// maxTokens（Phase K demo 用）：有帶＝三種上游都強制回覆長度上限；沒帶＝會員路徑原行為
//（anthropic 必填、維持 PG_LIMITS.maxTokens；openai/gemini 不設限）。
// defaultSys：管道沒填系統提示詞時要套的那段（呼叫端用 pgDefaultSystem(env) 取得，
//   已經處理過「站台設定 → 內建」的優先序）。沒帶＝直接用內建 PG_DEFAULT_SYSTEM，
//   所以這個函式維持純同步、單元測試不必準備 D1。
export function buildUpstream(
  ch: ChannelRow,
  model: string,
  messages: ChatMsg[],
  maxTokens?: number,
  defaultSys?: string
): { url: string; headers: Record<string, string>; body: string } {
  // 管道層系統提示詞（relay_channels.system_prompt，migration 0005）：只在 playground 生效。
  // /relay API 中轉走 src/routes/relay/[[path]].ts 原樣轉發、根本不經過這個函式 —
  // 會員拿 uak- 金鑰打中轉的行為完全不受影響（刻意：中轉要保持透明代理）。
  // 管道沒填＝套站台預設（/settings 可改，管理員視窗裡的灰字就是它）；填了就整段換掉。
  // 擺最前面，對話裡原有的 system 訊息接在後面 — 兩者都生效，不互相覆蓋。
  const fallback = String(defaultSys == null ? "" : defaultSys).trim() || PG_DEFAULT_SYSTEM;
  const chSys = String(ch.system_prompt == null ? "" : ch.system_prompt).trim() || fallback;
  const sys = (chSys ? [chSys] : [])
    .concat(
      messages
        .filter(function (m) {
          return m.role === "system";
        })
        .map(function (m) {
          return m.content;
        })
    )
    .join("\n\n");
  const rest = messages.filter(function (m) {
    return m.role !== "system";
  });

  if (ch.kind === "anthropic") {
    return {
      url: ch.base_url + "/v1/messages",
      headers: {
        "content-type": "application/json",
        "x-api-key": ch.api_key,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify(
        mergeExtraBody(
          {
            model: model,
            max_tokens: maxTokens || PG_LIMITS.maxTokens,
            stream: true,
            system: sys || undefined,
            messages: rest.map(function (m) {
              return { role: m.role, content: m.content };
            })
          },
          ch.extra_body
        )
      )
    };
  }
  if (ch.kind === "gemini") {
    // Gemini 原生端點；金鑰只走 x-goog-api-key（多送 Authorization 會 401，中轉那邊實測過）
    const enc = encodeURIComponent(model).replace(/%2F/gi, "/");
    return {
      url: ch.base_url + "/v1beta/models/" + enc + ":streamGenerateContent?alt=sse",
      headers: { "content-type": "application/json", "x-goog-api-key": ch.api_key },
      body: JSON.stringify(
        mergeExtraBody(
          {
            contents: rest.map(function (m) {
              return { role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] };
            }),
            systemInstruction: sys ? { parts: [{ text: sys }] } : undefined,
            generationConfig: maxTokens ? { maxOutputTokens: maxTokens } : undefined
          },
          ch.extra_body
        )
      )
    };
  }
  // openai / custom：OpenAI 相容介面（system 直接留在 messages 裡）
  // 管道提示詞塞成最前面一則 system；對話裡原有的 system 訊息原位保留。
  const oaMsgs: ChatMsg[] = chSys
    ? ([{ role: "system", content: chSys }] as ChatMsg[]).concat(messages)
    : messages;
  const body: Record<string, unknown> = { model: model, stream: true, messages: oaMsgs };
  if (maxTokens) body.max_tokens = maxTokens;
  // 串流尾端要上游回報 token 用量（計量用）。只對 kind='openai' 加 —
  // custom 常是本地／自架服務，可能拒收不認識的欄位（記在 DEBT）。
  if (ch.kind === "openai") body.stream_options = { include_usage: true };
  return {
    url: ch.base_url + "/v1/chat/completions",
    headers: { "content-type": "application/json", authorization: "Bearer " + ch.api_key },
    body: JSON.stringify(mergeExtraBody(body, ch.extra_body))
  };
}

// 從上游 SSE 的一筆 JSON 取出增量文字；上游夾帶錯誤時丟 Error

export function extractDelta(kind: string, j: any): string {
  if (kind === "anthropic") {
    if (j.type === "error") throw new Error((j.error && j.error.message) || "upstream error");
    if (j.type === "content_block_delta" && j.delta && typeof j.delta.text === "string") return j.delta.text;
    return "";
  }
  if (kind === "gemini") {
    if (j.error) throw new Error(j.error.message || "upstream error");
    let out = "";
    const parts =
      (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [];
    // 標了 thought 的 part 是思考過程，歸 extractReasoning 管 — 這裡略過才不會重複計入正文
    for (let i = 0; i < parts.length; i++)
      if (!parts[i].thought && typeof parts[i].text === "string") out += parts[i].text;
    return out;
  }
  if (j.error) throw new Error((j.error && j.error.message) || String(j.error));
  const d = j.choices && j.choices[0] && j.choices[0].delta;
  return d && typeof d.content === "string" ? d.content : "";
}

// 從上游 SSE 的一筆 JSON 取出「思考過程」增量（推理模型專用；2026-07-21）。
//
// 為什麼要有這個：推理模型不把思考放在正文欄位，各家擺法還都不一樣。以前只讀正文
// 的結果是——思考階段整段被丟掉，瀏覽器一個字都收不到，畫面空白幾十秒像當機；
// 模型若把輸出預算全花在思考上，正文是空的，串流就這樣無聲結束（實測 GLM-4.7：
// 691 筆 delta 裡 627 筆是 reasoning_content，946 字思考 vs 79 字正文）。
//
// 各家欄位：GLM／DeepSeek 系＝delta.reasoning_content；OpenRouter 轉出來＝delta.reasoning；
// anthropic＝thinking_delta 的 delta.thinking；gemini＝parts[].thought 標記的 part。
// 取不到一律回空字串 — 非推理模型走這裡不會有任何副作用。
// 不丟 Error：錯誤一律留給 extractDelta 判（同一筆 JSON 兩邊都會經過，避免重複拋）。
export function extractReasoning(kind: string, j: any): string {
  if (kind === "anthropic") {
    if (j.type === "content_block_delta" && j.delta && typeof j.delta.thinking === "string")
      return j.delta.thinking;
    return "";
  }
  if (kind === "gemini") {
    let out = "";
    const parts =
      (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [];
    for (let i = 0; i < parts.length; i++)
      if (parts[i].thought && typeof parts[i].text === "string") out += parts[i].text;
    return out;
  }
  const d = j.choices && j.choices[0] && j.choices[0].delta;
  if (!d) return "";
  if (typeof d.reasoning_content === "string") return d.reasoning_content;
  if (typeof d.reasoning === "string") return d.reasoning;
  return "";
}

// 上游不支援串流、直接回一整包 JSON 時的取文字（備援路徑）

export function extractFull(kind: string, j: any): string {
  try {
    if (kind === "anthropic") {
      return (j.content || [])
        .map(function (c: any) {
          return (c && c.text) || "";
        })
        .join("");
    }
    if (kind === "gemini") {
      const parts =
        (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [];
      return parts
        .map(function (p: any) {
          return (p && p.text) || "";
        })
        .join("");
    }
    return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "";
  } catch (e) {
    return "";
  }
}

// relay_channels.models（逗號分隔）→ 陣列
export function chModels(ch: { models?: unknown } | null | undefined): string[] {
  return String((ch && ch.models) || "")
    .split(",")
    .map(function (s) {
      return s.trim();
    })
    .filter(Boolean);
}

// 從上游的一筆 JSON（SSE 事件或整包回應）累積 token 用量到 acc（計量用，2026-07-14）。
// 三家的擺法：anthropic 的 message_start 有 input、message_delta 尾端補 output；
// gemini 每筆都可能帶 usageMetadata（最後一筆才完整）；openai 在最後一筆的 usage。
// 一律「有值就覆寫」— 串流結束時 acc 就是最終值。任何格式意外都靜默略過。
export interface UsageAcc {
  tokens_in: number | null;
  tokens_out: number | null;
}

export function extractUsage(kind: string, j: any, acc?: UsageAcc | null): UsageAcc {
  acc = acc || { tokens_in: null, tokens_out: null };
  try {
    if (kind === "anthropic") {
      const u = (j.type === "message_start" && j.message && j.message.usage) || j.usage || null;
      if (u) {
        if (typeof u.input_tokens === "number") acc.tokens_in = u.input_tokens;
        if (typeof u.output_tokens === "number") acc.tokens_out = u.output_tokens;
      }
    } else if (kind === "gemini") {
      const u = j.usageMetadata;
      if (u) {
        if (typeof u.promptTokenCount === "number") acc.tokens_in = u.promptTokenCount;
        if (typeof u.candidatesTokenCount === "number") acc.tokens_out = u.candidatesTokenCount;
      }
    } else if (j && j.usage) {
      if (typeof j.usage.prompt_tokens === "number") acc.tokens_in = j.usage.prompt_tokens;
      if (typeof j.usage.completion_tokens === "number") acc.tokens_out = j.usage.completion_tokens;
    }
  } catch (e) {}
  return acc;
}
