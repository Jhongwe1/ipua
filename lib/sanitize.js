// lib/sanitize.js — 零依賴的 HTML 白名單消毒器（2026-07-16 v2 Phase B）。
//
// 用在所有「Markdown → HTML → 直接進頁面」的地方（文章、自訂頁面、?html=1 API）。
// marked 會把 Markdown 裡的**原始 HTML 原樣放行**，所以管理員 token 失竊時，
// 攻擊者可以在文章裡夾 <script>／onerror=…，這裡是最後一道閘門：
//   1. 標籤白名單 — 只留 marked 會產出的（＋常見無害行內標籤），其餘拔掉標籤、保留文字。
//   2. 危險容器（script/style/iframe/svg…）連內容整段丟棄。
//   3. 屬性白名單（逐標籤）— 白名單外一律剝除（on* 事件、style 自然出局）；
//      屬性一律重建輸出，絕不把原始屬性字串放行。
//   4. URL scheme 白名單 — href/src 先做「瀏覽器等價」的實體解碼再驗 scheme，
//      擋 javascript:、data:text/html 與 &#106;avascript 這類實體混淆。
//
// 消毒對象是 marked 的輸出（正規 HTML），不求解析所有畸形 HTML —
// 解析不了的 < 一律跳脫成 &lt;，寧可顯示醜也不放行。

// 標籤白名單：值＝這個標籤額外允許的屬性（class/title 全域允許，見 ATTR_GLOBAL）
const ALLOW = {
  p: [], br: [], hr: [], h1: [], h2: [], h3: [], h4: [], h5: [], h6: [],
  ul: [], ol: ["start"], li: [], blockquote: [], pre: [], code: [],
  em: [], strong: [], del: [], s: [], b: [], i: [], u: [], sub: [], sup: [],
  mark: [], small: [], kbd: [], q: [], cite: [], abbr: [],
  table: [], thead: [], tbody: [], tfoot: [], tr: [], caption: [],
  th: ["align"], td: ["align"],
  dl: [], dt: [], dd: [], figure: [], figcaption: [], details: [], summary: [],
  a: ["href"],
  img: ["src", "alt", "width", "height", "loading"],
  input: ["type", "checked", "disabled"]   // gfm 任務清單的核取方塊
};
const ATTR_GLOBAL = ["class", "title"];
const VOID = { br: 1, hr: 1, img: 1, input: 1 };
// 這些標籤連「內容」都整段丟（script 的原始碼、iframe 的 fallback…都不該出現在頁面上）
const DROP_CONTENT = {
  script: 1, style: 1, iframe: 1, object: 1, embed: 1, svg: 1, math: 1,
  form: 1, select: 1, textarea: 1, button: 1, noscript: 1, template: 1,
  audio: 1, video: 1, dialog: 1, slot: 1
};
// DROP_CONTENT 裡的 void 元素（無結束標籤）：只丟標籤本身，別進「找 </tag>」的丟棄模式
const DROP_VOID = { embed: 1 };

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

// 單次實體解碼（等價瀏覽器對屬性值的一次解碼）：驗 URL scheme 前先還原真面目
function decodeEntities(s) {
  return String(s).replace(/&(?:#x([0-9a-f]+)|#(\d+)|(amp|lt|gt|quot|apos));?/gi,
    function (m, hex, dec, name) {
      if (hex || dec) {
        const cp = parseInt(hex || dec, hex ? 16 : 10);
        return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : "�";
      }
      return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[name.toLowerCase()] || m;
    });
}

// URL 白名單：http(s)／mailto／站內相對路徑；img 另收 data:image/（點陣格式）。
// 其他一切帶 scheme 的（javascript:、vbscript:、data:text/html…）回 null＝整個屬性拔掉。
function safeUrl(raw, tag) {
  const decoded = decodeEntities(String(raw || "")).trim();
  // 瀏覽器解析 URL 前會忽略控制字元與空白 — 驗證用的探針也照做（java\tscript: 擋得住）
  let probe = "";
  for (let k = 0; k < decoded.length; k++) {
    const c = decoded.charCodeAt(k);
    if (c <= 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0xad ||
        (c >= 0x200b && c <= 0x200f) || c === 0x2028 || c === 0x2029 || c === 0xfeff) continue;
    probe += decoded[k];
  }
  probe = probe.toLowerCase();
  if (!probe) return null;
  if (/^(?:https?|mailto):/.test(probe)) return decoded;
  if (tag === "img" && /^data:image\/(?:png|jpe?g|gif|webp|avif)[;,]/.test(probe)) return decoded;
  if (/^[a-z][a-z0-9+.-]*:/.test(probe)) return null;
  return decoded;   // 相對路徑、/絕對路徑、#錨點、?查詢、//協定相對
}

// 重建一顆開標籤：只放行白名單屬性、值全部重新跳脫
function buildTag(tag, attrText) {
  const allowed = ALLOW[tag].concat(ATTR_GLOBAL);
  const ATTR_RE = /([a-zA-Z_][\w:.-]*)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g;
  let out = "<" + tag, m;
  const seen = {};
  while ((m = ATTR_RE.exec(attrText || ""))) {
    const name = m[1].toLowerCase();
    if (allowed.indexOf(name) < 0 || seen[name]) continue;
    let v = m[2] == null ? "" : m[2];
    if (v && (v.charAt(0) === '"' || v.charAt(0) === "'")) v = v.slice(1, -1);
    if (name === "href" || name === "src") {
      const u = safeUrl(v, tag);
      if (u == null) continue;
      out += " " + name + '="' + esc(u) + '"';
    } else if (name === "align") {
      v = v.toLowerCase();
      if (["left", "right", "center", "justify"].indexOf(v) < 0) continue;
      out += ' align="' + v + '"';
    } else if (name === "width" || name === "height" || name === "start") {
      if (!/^\d{1,5}$/.test(v)) continue;
      out += " " + name + '="' + v + '"';
    } else if (name === "loading") {
      if (v !== "lazy" && v !== "eager") continue;
      out += ' loading="' + v + '"';
    } else if (name === "checked" || name === "disabled") {
      out += " " + name;
    } else if (name === "type") {
      out += ' type="checkbox"';   // input 只收 checkbox（呼叫端已先驗過）
    } else {
      out += " " + name + '="' + esc(decodeEntities(v)) + '"';
    }
    seen[name] = 1;
  }
  return out + ">";
}

// 主函式：白名單消毒。輸入預期是 marked 的輸出，但畸形輸入也不會放行任何危險內容。
export function sanitizeHtml(input) {
  let s = String(input == null ? "" : input);
  s = s.replace(/<!--[\s\S]*?(?:-->|$)/g, "");            // HTML 註解整段移除
  const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
  let out = "", i = 0, m;
  let dropTag = "", dropDepth = 0;                        // 危險容器丟棄狀態
  while ((m = TAG_RE.exec(s))) {
    const text = s.slice(i, m.index);
    if (!dropDepth) out += text.replace(/</g, "&lt;");    // 沒配成標籤的 < 一律跳脫
    i = TAG_RE.lastIndex;
    const closing = m[1] === "/", tag = m[2].toLowerCase(), attrs = m[3] || "";
    if (dropDepth) {                                      // 丟棄模式：只數同名巢狀深度
      if (tag === dropTag) dropDepth += closing ? -1 : 1;
      if (dropDepth <= 0) { dropTag = ""; dropDepth = 0; }
      continue;
    }
    if (DROP_CONTENT[tag]) {
      if (!closing && !DROP_VOID[tag] && !/\/\s*$/.test(attrs)) { dropTag = tag; dropDepth = 1; }
      continue;                                           // 自閉合／孤兒閉合／void：只丟標籤本身
    }
    if (!Object.prototype.hasOwnProperty.call(ALLOW, tag)) continue;   // 白名單外：拔標籤留文字
    if (closing) { if (!VOID[tag]) out += "</" + tag + ">"; continue; }
    if (tag === "input" && !/type\s*=\s*["']?checkbox\b/i.test(attrs)) continue;
    out += buildTag(tag, attrs);
  }
  if (!dropDepth) out += s.slice(i).replace(/</g, "&lt;");   // 沒關的危險容器：尾巴全丟
  return out;
}
