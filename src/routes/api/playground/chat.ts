// POST /api/playground/chat — Playground 的聊天端點（SSE 串流）。
// 本體：{ conv_id?, channel, model, messages:[{role,content}…] }（messages＝完整上下文，最後一則是 user）。
//
// 流程：驗身分（cookie 或管理員金鑰）→ 查渠道與模型 → 沒帶 conv_id 就自動開新對話
// → 存 user 訊息 → 帶上游金鑰打上游（串流）→ 轉成統一 SSE 回瀏覽器
// → 串完（或會員按停止）把 assistant 回覆存進 D1。
//
// 回給瀏覽器的 SSE 事件（每筆都是 data: JSON）：
//   { conv, title? }   一開始先告訴前端對話編號（新對話附自動取的標題）
//   { r: "文字" }      推理模型的思考增量（前端畫成可摺疊區塊；不存進 D1）
//   { d: "文字" }      增量內容
//   { error, hint }    中途出錯（已生成的部分照存）；整趟沒有正文＝error:"empty-output"
//   { done: true }     結束
// r 與 d 都是「批次合併後」才送 — 逐筆轉推會燒穿免費方案 10ms CPU 上限（見下方 push/flush）。
// 上游一開始就失敗時不進 SSE，直接回 JSON 錯誤（body 會帶 conv，前端才不會重複開對話）。
import { json } from "../../../lib/site.js";
import { isAdminUser, getSessionUser, goodOrigin } from "../../../lib/auth.js";
import {
  pgUser,
  cleanChat,
  buildUpstream,
  extractDelta,
  extractReasoning,
  extractFull,
  extractUsage,
  chModels
} from "../../../lib/playground.js";
import { checkQuota } from "../../../lib/quota.js";
import { demoCfg, demoUser, demoCheck, DEMO_DEFAULTS } from "../../../lib/demo.js";
import { reportError, reportErrorNow } from "../../../lib/observe.js";
import type { DemoCfg } from "../../../lib/demo.js";
import type { UsageAcc } from "../../../lib/playground.js";
import type { ChannelRow, RouteCtx, UserRow } from "../../../types.js";

// 會員看的上游錯誤一律用「安全分類字」— 上游的原始錯誤內容（格式、文件連結、專案編號）
// 會洩漏真實提供商身分，只有管理員能看原文（除錯用）。
function safeHint(status: number): string {
  if (status === 401 || status === 403) return "渠道憑證可能失效，請聯絡管理員";
  if (status === 429) return "上游流量限制，請稍後再試";
  if (status >= 500) return "上游暫時故障，請稍後再試";
  return "上游回應異常（HTTP " + status + "）";
}

export async function onRequestPost(context: RouteCtx): Promise<Response> {
  const { request, env } = context;
  const url = new URL(request.url);
  if (!env.DB) return json({ error: "no-db" }, 500);
  const who = await pgUser(request, env, url);
  let user: UserRow;
  let demo: DemoCfg | null = null;
  if (who.err) {
    // Demo 體驗模式（Phase K，ADR-0009）：只接「完全沒登入」的匿名訪客 —
    // 帶了 Authorization（金鑰打錯）或有登入但沒批准的，照樣回原本的 401/403。
    if (!request.headers.get("authorization") && !(await getSessionUser(request, env))) {
      const cfg = await demoCfg(env);
      if (cfg.on) demo = cfg;
    }
    if (!demo) return who.err;
    if (!goodOrigin(request, url, env)) return json({ error: "bad-origin" }, 403);
    const gate = await demoCheck(env, demo, request); // fail-closed，在任何 D1 寫入之前
    if (!gate.ok) return gate.resp;
    user = await demoUser(env); // req_log 記帳身分（成本記帳自然涵蓋 demo）
  } else {
    user = who.user;
  }
  const isAdm = demo ? false : isAdminUser(user, env);

  if (!demo) {
    // 會員配額（fail-open）：一定要在「任何 D1 寫入之前」— 429 時連對話都不會建（管理員豁免）
    const quota = await checkQuota(env, user, "pg");
    if (!quota.ok) return quota.resp;
  }

  let body: any = null;
  try {
    body = await request.json();
  } catch (e) {}
  const v = cleanChat(body);
  if (v.err !== undefined) return json({ error: "bad-input", hint: v.err }, 400);

  if (demo) {
    // demo 鎖定：渠道只能是指定那個（先擋再查 DB，匿名者探測不到其他渠道 slug）；
    // 輸入整包 4k 字上限（比會員的 300k 小兩個數量級）
    if (v.channel !== demo.channel) {
      return json({ error: "demo-locked", hint: "體驗模式只開放指定的渠道" }, 403);
    }
    let total = 0;
    for (const m of v.messages) total += m.content.length;
    if (total > DEMO_DEFAULTS.maxInputChars) {
      return json(
        {
          error: "demo-too-long",
          hint: "體驗模式輸入上限 " + DEMO_DEFAULTS.maxInputChars + " 字 — 登入後可用完整長度"
        },
        400
      );
    }
  }

  // 渠道與模型（模型一定要在渠道設定的清單裡 — 會員只能用管理員開出來的）
  let ch: ChannelRow | null = null;
  try {
    ch = await env.DB.prepare("SELECT * FROM relay_channels WHERE slug=?1 AND enabled=1")
      .bind(v.channel)
      .first<ChannelRow>();
  } catch (e) {}
  if (!ch)
    return json({ error: "unknown-channel", hint: "沒有「" + v.channel + "」這個渠道（或已停用）" }, 404);
  if (chModels(ch).indexOf(v.model) < 0) {
    return json({ error: "bad-model", hint: "渠道「" + ch.name + "」沒有開放模型「" + v.model + "」" }, 400);
  }
  if (demo && demo.models.length && demo.models.indexOf(v.model) < 0) {
    return json({ error: "demo-locked", hint: "體驗模式沒有開放這個模型" }, 403);
  }
  if (!ch.api_key)
    return json({ error: "no-upstream-key", hint: "渠道還沒設定上游金鑰，請管理員到 /relay 補上" }, 502);

  // 對話：沒帶 conv_id＝開新對話（標題自動取第一句 user 訊息）。
  // demo 不落對話表 — 對話只活在訪客瀏覽器裡（convId 維持 null）。
  const now = new Date().toISOString();
  let convId = v.convId,
    newTitle: string | null = null;
  if (demo) {
    convId = null;
  } else if (convId) {
    const conv = await env.DB.prepare("SELECT id FROM pg_conversations WHERE id=?1 AND user_id=?2")
      .bind(convId, user.id)
      .first();
    if (!conv) return json({ error: "not-found", hint: "找不到這個對話" }, 404);
  } else {
    const first = v.messages.filter(function (m) {
      return m.role === "user";
    })[0];
    newTitle =
      String((first && first.content) || "新對話")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 60) || "新對話";
    const r = await env.DB.prepare(
      "INSERT INTO pg_conversations (user_id,title,channel,model,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?5)"
    )
      .bind(user.id, newTitle, v.channel, v.model, now)
      .run();
    convId = r.meta.last_row_id;
  }
  if (!demo) {
    // 先存 user 訊息 — 就算上游掛了，會員的問題也不會消失
    const lastUser = v.messages[v.messages.length - 1];
    await env.DB.prepare(
      "INSERT INTO pg_messages (conv_id,role,content,model,created_at) VALUES (?1,'user',?2,?3,?4)"
    )
      .bind(convId, lastUser.content, v.model, now)
      .run();
  }

  // 打上游（demo 強制低 max_tokens — 燒錢上限的另一半）
  const up = buildUpstream(ch, v.model, v.messages, demo ? demo.maxTokens : undefined);
  const t0 = Date.now();
  let resp: Response;
  try {
    resp = await fetch(up.url, { method: "POST", headers: up.headers, body: up.body });
  } catch (e: any) {
    // fetch 例外訊息可能含主機名 → 只有管理員看得到；站內 errlog 留完整一筆
    reportError(
      env,
      function (p) {
        context.waitUntil(p);
      },
      "pg.upstream",
      e,
      { user_id: user.id, path: "/playground/" + v.channel }
    );
    return json(
      {
        error: "upstream-unreachable",
        hint: "連不上上游（" + ch.name + "）",
        conv: convId,
        detail: isAdm ? String((e && e.message) || e) : undefined
      },
      502
    );
  }
  if (!resp.ok) {
    const detail = String(
      await resp.text().catch(function () {
        return "";
      })
    ).slice(0, 2000);
    reportError(
      env,
      function (p) {
        context.waitUntil(p);
      },
      "pg.upstream",
      "上游回應 HTTP " + resp.status,
      { user_id: user.id, path: "/playground/" + v.channel, detail: detail }
    );
    if (!isAdm) return json({ error: "upstream-error", hint: safeHint(resp.status), conv: convId }, 502);
    return json(
      { error: "upstream-error", hint: "上游回應 " + resp.status, conv: convId, detail: detail },
      502
    );
  }

  // 統一 SSE 輸出；上游讀取與 D1 寫入掛在 waitUntil，回應先開始流
  const ts = new TransformStream();
  const writer = ts.writable.getWriter();
  const enc = new TextEncoder();
  let gone = false; // 瀏覽器斷線／按停止 → 寫入會失敗 → 停止抓上游、保留已生成內容
  function send(obj: unknown) {
    if (gone) return Promise.resolve();
    return writer.write(enc.encode("data: " + JSON.stringify(obj) + "\n\n")).catch(function () {
      gone = true;
    });
  }
  const ct = String(resp.headers.get("content-type") || "");
  const ttfb = Date.now() - t0; // 上游回應標頭到手的時間
  const usage: UsageAcc = { tokens_in: null, tokens_out: null }; // 上游回報的 token 用量（掃不到＝NULL）

  context.waitUntil(
    (async function () {
      let full = "",
        errMsg: string | null = null,
        sawReasoning = false, // 這趟有沒有收到思考增量（決定空回覆時的提示怎麼寫）
        emptyOut = false; // 上游有回應、但整趟沒給出任何正式內容

      // ── 增量批次送出（2026-07-21，這是 CPU 上限的解法，不是效能微調）──
      // 免費方案每次呼叫只有 10ms CPU。以前每收到一筆上游增量就 JSON.stringify＋編碼＋
      // 寫一次串流，CPU 消耗跟回覆長度成正比 — 回覆一長就撞上限，isolate 直接被殺，
      // 串流無聲中斷（瀏覽器沒有錯誤、D1 也來不及寫，連 req_log 都沒有）。
      // 實測 GLM-4.7 一次回答有 691 筆增量；合併後只剩幾十次寫入。
      // 註：Workers 的 Date.now() 只在 I/O 後前進，而每次 reader.read() 都是 I/O，
      //     所以時間門檻會照常生效；字數門檻是保險。
      let pend = "",
        pendKind: "r" | "d" | null = null,
        lastFlush = Date.now();
      async function flush() {
        if (!pend || !pendKind) return;
        const payload = pendKind === "r" ? { r: pend } : { d: pend };
        pend = "";
        lastFlush = Date.now();
        await send(payload);
      }
      // 思考與正文分開累積，型別一換就先送出 — 兩者的先後順序不會被打亂
      async function push(kind: "r" | "d", text: string) {
        if (pendKind !== kind) {
          await flush();
          pendKind = kind;
        }
        pend += text;
        // 100ms／1000 字：約每秒 10 次更新，肉眼仍是流暢的逐字浮現，
        // 但送出次數比逐筆轉推少一個數量級 — 長回覆才不會把 CPU 額度用完。
        if (pend.length >= 1000 || Date.now() - lastFlush >= 100) await flush();
      }
      try {
        // demo 沒有對話編號 — 第一筆事件改標 demo，前端不做任何對話列表動作
        await send(demo ? { demo: true } : newTitle ? { conv: convId, title: newTitle } : { conv: convId });
        if (ct.indexOf("json") >= 0 && ct.indexOf("event-stream") < 0) {
          // 上游不理 stream:true、直接回整包 JSON → 一次送完（相容便宜渠道的怪行為）
          const j: any = await resp.json();
          extractUsage(ch.kind, j, usage);
          full = extractFull(ch.kind, j) || "";
          if (full) await send({ d: full });
          else errMsg = "上游沒有回覆內容";
        } else {
          const reader = resp.body!.getReader();
          const dec = new TextDecoder();
          let buf = "";
          readLoop: while (true) {
            const step = await reader.read();
            if (step.done) break;
            buf += dec.decode(step.value, { stream: true });
            let idx;
            while ((idx = buf.indexOf("\n")) >= 0) {
              const line = buf.slice(0, idx).replace(/\r$/, "");
              buf = buf.slice(idx + 1);
              if (line.indexOf("data:") !== 0) continue;
              const payload = line.slice(5).trim();
              if (!payload || payload === "[DONE]") continue;
              let j: any = null;
              try {
                j = JSON.parse(payload);
              } catch (e) {
                continue;
              }
              extractUsage(ch.kind, j, usage);
              let t = "";
              try {
                t = extractDelta(ch.kind, j);
              } catch (e: any) {
                errMsg = String((e && e.message) || e);
                break readLoop;
              }
              // 思考增量走獨立事件（前端畫成可摺疊的「思考中…」區塊）。
              // 不併進 full — 存進 D1 的只有正式回覆，思考過程不落地。
              const rd = extractReasoning(ch.kind, j);
              if (rd) {
                sawReasoning = true;
                await push("r", rd);
              }
              if (t) {
                full += t;
                await push("d", t);
              }
              if (gone) break readLoop;
            }
          }
          await flush(); // 收尾：把還沒滿門檻的殘量送出去
          if (gone || errMsg) {
            try {
              reader.cancel();
            } catch (e) {}
          }
        }
      } catch (e: any) {
        errMsg = errMsg || String((e && e.message) || e);
      }
      // 例外路徑會跳過迴圈尾端的 flush — 這裡再保險一次（沒殘量就是 no-op）
      try {
        await flush();
      } catch (e) {}
      // 上游正常結束、卻連一個字的正文都沒有 → 不能靜默收場。
      // 以前這裡直接送 done，會員看到的就是「沒回覆、沒報錯、就這樣沒了」。
      // 會員自己按停止（gone）不算異常。
      if (!full && !errMsg && !gone) emptyOut = true;
      // 存回 D1（部分回應也存 — 按「停止」時已生成的內容留著）。
      // demo 只寫 req_log（記帳／限流觀測），對話內容一個字都不落地。
      try {
        const t2 = new Date().toISOString();
        const stmts: D1PreparedStatement[] = [];
        if (!demo && full) {
          stmts.push(
            env.DB.prepare(
              "INSERT INTO pg_messages (conv_id,role,content,model,created_at) VALUES (?1,'assistant',?2,?3,?4)"
            ).bind(convId, full, v.model, t2)
          );
        }
        if (!demo) {
          stmts.push(
            env.DB.prepare(
              "UPDATE pg_conversations SET updated_at=?1, channel=?2, model=?3 WHERE id=?4"
            ).bind(t2, v.channel, v.model, convId)
          );
        }
        // 計量：req_log 併進同一個 batch（配額計數與延遲/成本研究數據共用）
        stmts.push(
          env.DB.prepare(
            "INSERT INTO req_log (ts,user_id,svc,channel,model,status,dur_ms,ttfb_ms,tokens_in,tokens_out) " +
              "VALUES (?1,?2,'pg',?3,?4,?5,?6,?7,?8,?9)"
          ).bind(
            t2,
            user.id,
            v.channel,
            v.model,
            resp.status,
            Date.now() - t0,
            ttfb,
            usage.tokens_in,
            usage.tokens_out
          )
        );
        await env.DB.batch(stmts);
      } catch (e) {
        // 持久化失敗＝會員的回覆沒存進去 — 一定要留痕跡（已在 waitUntil 裡，直接 await）
        await reportErrorNow(env, "pg.persist", e, { user_id: user.id, path: "/playground/" + v.channel });
      }
      // 串流中途的錯誤訊息是上游原文（會露出提供商身分）→ 會員只看安全字，管理員看原文
      if (errMsg) {
        await reportErrorNow(env, "pg.stream", errMsg, {
          user_id: user.id,
          path: "/playground/" + v.channel
        });
        await send({ error: "upstream-error", hint: isAdm ? errMsg : "上游發生錯誤，請稍後再試" });
      } else if (emptyOut) {
        // 這兩句都不含上游身分（沒有提供商名稱、網址、原始錯誤），會員看得到全文
        const hint = sawReasoning
          ? "模型只輸出了思考過程，沒有給出正式回覆 — 請再問一次，或換一個模型"
          : "上游沒有回覆內容，請再試一次";
        await reportErrorNow(
          env,
          "pg.empty",
          sawReasoning ? "只有思考內容、沒有正式回覆" : "上游沒有回覆內容",
          {
            user_id: user.id,
            path: "/playground/" + v.channel
          }
        );
        await send({ error: "empty-output", hint: hint });
      }
      await send({ done: true });
      try {
        await writer.close();
      } catch (e) {}
    })()
  );

  return new Response(ts.readable, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no"
    }
  });
}
