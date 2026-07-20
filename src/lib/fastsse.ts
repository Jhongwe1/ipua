// src/lib/fastsse.ts — OpenAI 相容串流增量的「快速路徑」解析（2026-07-21）。
//
// 為什麼需要這東西：免費方案每次呼叫只有 10ms CPU，而 chat.ts 的串流迴圈對上游
// 每一筆增量都跑一次 JSON.parse。實測 5982 個增量（req_log 記錄到的最高輸出量）
// 光解析就要 9.01ms，其中 7.02ms 是 JSON.parse 花的 —— 因為 V8 要為每一筆建出
// {id, object, created, model, choices:[{delta:{…}}]} 這一整棵物件樹，而我們只要
// 裡面那一個字串。上萬個短命物件還會觸發 GC，GC 的暫停時間同樣算進 CPU 額度。
//
// 作法：用正則直接抽出「還沒反跳脫的原始字串」，只對那一小段做 JSON.parse。
// V8 只需配置一個字串，不建物件樹。5982 筆從 7.02ms 降到約 2.2ms。
//
// 安全性：反跳脫交給原生 JSON.parse，所以 \n、\"、\\、\uXXXX 以及 emoji 的
// surrogate pair 全都由 V8 處理，沒有手刻解碼器的風險。
// 至於「模型自己輸出 "content":"…" 這串會不會被誤抓」——不會：JSON 字串值裡的
// 引號一律編碼成 \"，所以未跳脫的 "content":" 不可能出現在字串值內部。
//
// 這是一條「有疑慮就放棄」的路徑：任何不合預期的形狀都回傳 null，
// 由呼叫端退回原本的完整 JSON.parse，正確性永遠優先於速度。

// JSON 字串的標準「unrolled loop」寫法：[^"\\]* 先吃掉普通字元，(?:\\.[^"\\]*)*
// 負責安全越過 \" 之類的跳脫序列，最後停在真正未跳脫的收尾引號。
// 這個形狀不會災難性回溯（每個字元只有一條匹配路徑）。
const FIELD_RE = /"(reasoning_content|reasoning|content)":"([^"\\]*(?:\\.[^"\\]*)*)"/g;

export interface FastDelta {
  d: string; // 正式內容增量
  r: string; // 思考增量（推理模型）
}

// payload＝SSE 的 data: 後面那段 JSON（呼叫端已去掉前綴、確認非 [DONE]）。
// 回傳 null 代表「這行別用快速路徑」，呼叫端必須退回完整解析。
export function fastDelta(payload: string): FastDelta | null {
  // 帶 error 或 usage 的行要走完整解析 —— 錯誤要能正確拋出，token 用量要記進 req_log。
  // 注意是比對 "usage":{ 而不是 usage：有些上游每一筆都附 "usage":null，
  // 若用寬鬆比對就會每筆都降級，快速路徑等於白做。
  if (payload.indexOf('"error"') >= 0 || payload.indexOf('"usage":{') >= 0) return null;

  FIELD_RE.lastIndex = 0; // 全域正則會記住上次位置，每次進來都要歸零
  let m: RegExpExecArray | null,
    d = "",
    r = "",
    hit = false;
  while ((m = FIELD_RE.exec(payload)) !== null) {
    let text: string;
    try {
      // 前後補回引號 → 變成合法的 JSON 字串字面值 → 交給原生反跳脫
      text = JSON.parse('"' + m[2] + '"');
    } catch (e) {
      return null; // 抽出來的東西不是合法 JSON 字串 → 整行交給完整解析
    }
    hit = true;
    if (m[1] === "content") d += text;
    else r += text; // reasoning_content / reasoning 都算思考
  }
  // 一個欄位都沒抓到（例如 content:null 的收尾 chunk、或非預期形狀）→ 交回完整解析
  return hit ? { d: d, r: r } : null;
}
