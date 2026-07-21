// tools/bench-sse.mjs — ADR-0011 那個「9.01ms → 4.2ms」的可重現版本。
//
// 用法：
//   node tools/bench-sse.mjs                 # 預設 5982 筆（線上實際觀測到的最高輸出量）
//   node tools/bench-sse.mjs 978             # 平均輸出量
//   node --expose-gc tools/bench-sse.mjs     # 建議：每次試跑從乾淨的堆開始，數字更穩
//
// 為什麼這支工具存在（三個理由，任何一個都值回票價）：
//   1. 讓 ADR-0011 的數字變成**別人可以自己跑**的東西。「我把 CPU 從 9.01ms 降到 4.2ms」
//      和「…，你可以自己跑一次」是兩個不同等級的句子。
//   2. 讓 DEBT #13 的門檻從事後變成**事前可測**。系統貼著 10ms 硬上限跑在 4.2ms，而失敗模式是
//      isolate 靜默死亡、應用層零痕跡（連 errlog 都寫不進去）—— 在這支工具之前，repo 裡沒有
//      任何東西能偵測「正在往懸崖靠近」。
//   3. 它是 ADR-0011 的考卷。重現不出那個比例，就代表沒讀懂那份 ADR 在說什麼。
//
// 量的是「解析側」：chat.ts 的串流迴圈對上游每一筆增量做的事。ADR 記載的另一半
// （寫入側的批次合併）不在這裡 —— 那個要真的跑 TransformStream 才量得到。
import { PerformanceObserver, performance } from "node:perf_hooks";
import { fastDelta } from "../src/lib/fastsse.ts";

const N = parseInt(process.argv[2] || "5982", 10);
const TRIALS = 7; // 取中位數：單次量測會被 GC 與排程雜訊帶著跑
const WARMUP = 2; // 先讓 V8 把兩條路徑都 JIT 起來，否則先跑的那條會被懲罰

/* ===== 造出跟線上同形狀的增量 =====
   ADR-0011 記載：每筆約 184 位元組，形狀是 OpenAI 相容的 chat.completion.chunk。
   內容以中文為主（線上流量就是），每 10 筆混一個需要反跳脫的東西（換行、引號、
   emoji 的 surrogate pair）—— 那正是「手刻解碼器會出錯、交給原生 JSON.parse 才安全」的地方，
   比例刻意貼近真實回覆，不是灌到讓快速路徑難看。 */
const PLAIN = ["的", "說", "，", "。", "程式", "資料", "問題", "可以", "一個", "系統"];
const ESCAPED = ["\\n", '\\"', "🙂"];
function makeChunk(i) {
  const text = i % 10 === 9 ? ESCAPED[Math.floor(i / 10) % ESCAPED.length] : PLAIN[i % PLAIN.length];
  return (
    '{"id":"chatcmpl-Bx7K2mQ9vZ3nR8sT1uW4xY","object":"chat.completion.chunk",' +
    '"created":1753142400,"model":"glm-4.7",' +
    '"choices":[{"index":0,"delta":{"content":"' +
    text +
    '"},"finish_reason":null}]}'
  );
}
const CHUNKS = Array.from({ length: N }, (_, i) => makeChunk(i));
const AVG_BYTES = Math.round(CHUNKS.reduce((a, c) => a + Buffer.byteLength(c), 0) / N);

/* ===== GC 觀測 =====
   ADR-0011 的關鍵論點之一是「配置成本被計費兩次」：短命物件本身要花時間配置，
   而清掉它們的 GC 暫停**同樣算進 CPU 額度**。所以這裡量的不是「堆上剩多少」
   （那是雜訊 —— 跑得快的那條反而留下較多還沒被回收的垃圾），而是 **GC 真正暫停了多久**。
   PerformanceObserver 的 gc 事件是**非同步**送達的，所以不能靠旗標開關來歸屬：
   一律收下來，最後再用「量測視窗」的時間區間去對帳。 */
const gcEntries = [];
new PerformanceObserver((list) => {
  for (const e of list.getEntries()) gcEntries.push({ start: e.startTime, dur: e.duration });
}).observe({ entryTypes: ["gc"] });

/* ===== 兩條路徑 =====
   slow：chat.ts 在 fastsse.ts 出現之前做的事 —— 整包 JSON.parse，再取出那一個字串。
   fast：現在的 lib/fastsse.ts（直接 import 正式程式碼，不是抄一份）。 */
function slowPath(chunks) {
  let out = "";
  for (let i = 0; i < chunks.length; i++) {
    const o = JSON.parse(chunks[i]);
    const d = o.choices && o.choices[0] && o.choices[0].delta;
    if (d && typeof d.content === "string") out += d.content;
  }
  return out;
}
function fastPath(chunks) {
  let out = "";
  for (let i = 0; i < chunks.length; i++) {
    const f = fastDelta(chunks[i]);
    if (f) out += f.d;
    else {
      // 快速路徑放棄 → 退回完整解析（正式程式碼就是這個行為，量測必須包含它）
      const o = JSON.parse(chunks[i]);
      const d = o.choices && o.choices[0] && o.choices[0].delta;
      if (d && typeof d.content === "string") out += d.content;
    }
  }
  return out;
}

/* ===== 先驗正確性，再談速度 =====
   一個不檢查輸出的 benchmark 只證明了「其中一條比較快」，沒證明它還是對的。
   兩條路徑的輸出必須逐字相同，否則下面的數字沒有意義。 */
const slowOut = slowPath(CHUNKS);
const fastOut = fastPath(CHUNKS);
if (slowOut !== fastOut) {
  console.error("✗ 兩條路徑輸出不一致 —— 快速路徑有錯，數字不用看了");
  console.error("  slow:", JSON.stringify(slowOut.slice(0, 120)));
  console.error("  fast:", JSON.stringify(fastOut.slice(0, 120)));
  process.exit(1);
}

/* ===== 量測 ===== */
const gc = typeof global.gc === "function" ? global.gc : null;
function measure(fn) {
  const times = [];
  const windows = [];
  for (let t = 0; t < WARMUP + TRIALS; t++) {
    if (gc) gc(); // 每次試跑從乾淨的堆開始
    const t0 = performance.now();
    fn(CHUNKS);
    const t1 = performance.now();
    if (t >= WARMUP) {
      times.push(t1 - t0);
      windows.push([t0, t1]); // 暖身階段的 GC 不算進來
    }
  }
  times.sort((a, b) => a - b);
  return {
    median: times[Math.floor(times.length / 2)],
    min: times[0],
    max: times[times.length - 1],
    windows
  };
}

const slow = measure(slowPath);
const fast = measure(fastPath);

// gc 事件非同步送達，等一拍再對帳
await new Promise((r) => setTimeout(r, 100));
function gcIn(windows) {
  let count = 0,
    ms = 0;
  for (const e of gcEntries) {
    for (const [a, b] of windows) {
      if (e.start >= a && e.start <= b) {
        count++;
        ms += e.dur;
        break;
      }
    }
  }
  return { count: count / TRIALS, ms: ms / TRIALS };
}
const slowGc = gcIn(slow.windows);
const fastGc = gcIn(fast.windows);

/* ===== 報告 ===== */
const f = (n, w = 7) => n.toFixed(2).padStart(w);
console.log("");
console.log("SSE 增量解析 benchmark（ADR-0011）");
console.log("  增量筆數     " + N + " 筆，平均 " + AVG_BYTES + " 位元組／筆");
console.log("  試跑         " + WARMUP + " 次暖身 + " + TRIALS + " 次取中位數");
console.log("  輸出一致性   ✓ 兩條路徑逐字相同（" + fastOut.length + " 字）");
console.log("");
console.log("                       中位數      最快      最慢    GC 次數   GC 暫停");
console.log(
  "  JSON.parse 全解析  " +
    f(slow.median) +
    "ms" +
    f(slow.min) +
    "ms" +
    f(slow.max) +
    "ms" +
    f(slowGc.count, 9) +
    "  " +
    f(slowGc.ms) +
    "ms"
);
console.log(
  "  fastDelta 快速路徑 " +
    f(fast.median) +
    "ms" +
    f(fast.min) +
    "ms" +
    f(fast.max) +
    "ms" +
    f(fastGc.count, 9) +
    "  " +
    f(fastGc.ms) +
    "ms"
);
console.log("");
console.log(
  "  省下 " +
    (slow.median - fast.median).toFixed(2) +
    "ms（" +
    (slow.median / fast.median).toFixed(2) +
    "×）；GC 暫停少 " +
    (slowGc.ms - fastGc.ms).toFixed(2) +
    "ms —— 配置成本被計費兩次，這是第二次那筆"
);
if (!gc) console.log("  （加 --expose-gc 可讓每次試跑從乾淨的堆開始，數字更穩）");
console.log("");
console.log("  ADR-0011 當時在作者桌機記錄的是 9.01ms → 4.2ms（同樣 5982 筆）。");
console.log("  絕對值會隨機器不同，**要看的是比例與 GC 那一欄**：快速路徑的 GC 次數應該是 0 ——");
console.log("  它只配置一個字串、不建物件樹，這正是 ADR 的核心主張。");

/* ===== 對照 10ms 硬上限 =====
   這是本工具最實用的一段：解析只是整趟請求的一部分（還有寫入側、D1 收尾、格式轉換），
   所以「解析佔掉幾成預算」比絕對數字更值得盯。本機桌機比 Workers isolate 快，
   所以這些是**下限** —— ADR 也是這樣標註的。 */
const BUDGET_MS = 10;
const pct = ((fast.median + fastGc.ms) / BUDGET_MS) * 100;
console.log("");
console.log("  對照免費方案的 10ms／次 CPU 上限（解析＋它自己造成的 GC 暫停）：");
console.log("    佔用 " + pct.toFixed(1) + "%（本機桌機；Workers isolate 更慢，這是下限）");
if (pct > 60) {
  console.log("    ⚠ 超過 60% —— DEBT #13 的門檻，該考慮再砍一輪或升級方案了");
  process.exitCode = 1;
} else if (pct > 40) {
  console.log("    △ 超過 40% —— 還有餘裕，但別再往每筆增量裡加東西");
} else {
  console.log("    ✓ 餘裕充足");
}
console.log("");
