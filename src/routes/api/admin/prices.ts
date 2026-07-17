// /api/admin/prices — 模型定價表（v2.0.0 Phase J 成本記帳）。
// GET：全部定價列（依 pattern 排序）。
// PUT：**整包覆蓋**（跟選單同款）：{ items: [ { pattern, input_usd_per_m, output_usd_per_m, note? }, … ] }；
//      空陣列＝清空＝所有模型回到「未定價」。匹配語意見 src/lib/cost.ts（精確 > 最長前綴 '*'）。
// 定價只影響報告顯示（stats／/logs 成本欄），不影響配額執法 — 填錯不會弄掛服務。
import { json } from "../../../lib/site.js";
import { adminOk } from "../../../lib/auth.js";
import { audit } from "../../../lib/observe.js";
import type { RouteCtx } from "../../../types.js";

const MAX_ITEMS = 200;

export async function onRequestGet({ request, env }: RouteCtx): Promise<Response> {
  const url = new URL(request.url);
  if (!(await adminOk(request, env, url))) return json({ error: "unauthorized" }, 401);
  if (!env.DB) return json({ error: "no-db" }, 500);
  try {
    const rs = await env.DB.prepare(
      "SELECT pattern,input_usd_per_m,output_usd_per_m,note,updated_at FROM model_prices ORDER BY pattern"
    ).all();
    return json({ items: rs.results || [] });
  } catch (e: any) {
    return json({ error: "query-failed", detail: String((e && e.message) || e) }, 500);
  }
}

export async function onRequestPut(context: RouteCtx): Promise<Response> {
  const { request, env } = context;
  const url = new URL(request.url);
  if (!(await adminOk(request, env, url))) return json({ error: "unauthorized" }, 401);
  if (!env.DB) return json({ error: "no-db" }, 500);

  let body: any = null;
  try {
    body = await request.json();
  } catch (e) {}
  const items = body && Array.isArray(body.items) ? body.items : null;
  if (!items) return json({ error: "bad-input", hint: "需要 items 陣列（空陣列＝清空定價表）" }, 400);
  if (items.length > MAX_ITEMS)
    return json({ error: "too-many", hint: "定價最多 " + MAX_ITEMS + " 列" }, 400);

  const seen: Record<string, boolean> = {};
  const clean: { pattern: string; input: number; output: number; note: string }[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i] || {};
    const pattern = String(it.pattern == null ? "" : it.pattern)
      .trim()
      .slice(0, 200);
    if (!pattern) return json({ error: "bad-input", hint: "第 " + (i + 1) + " 列沒有 pattern" }, 400);
    if (seen[pattern]) return json({ error: "bad-input", hint: "pattern 重複：" + pattern }, 400);
    seen[pattern] = true;
    const input = Number(it.input_usd_per_m);
    const output = Number(it.output_usd_per_m);
    if (!Number.isFinite(input) || input < 0 || !Number.isFinite(output) || output < 0) {
      return json(
        {
          error: "bad-input",
          hint: "「" + pattern + "」的 input/output_usd_per_m 要是 ≥0 的數字（每百萬 tokens 美元）"
        },
        400
      );
    }
    const note = String(it.note == null ? "" : it.note)
      .trim()
      .slice(0, 200);
    clean.push({ pattern: pattern, input: input, output: output, note: note });
  }

  try {
    const now = new Date().toISOString();
    const stmts = [env.DB.prepare("DELETE FROM model_prices")];
    for (const c of clean) {
      stmts.push(
        env.DB.prepare(
          "INSERT INTO model_prices (pattern,input_usd_per_m,output_usd_per_m,note,updated_at) VALUES (?1,?2,?3,?4,?5)"
        ).bind(c.pattern, c.input, c.output, c.note, now)
      );
    }
    await env.DB.batch(stmts);
    audit(
      env,
      function (p) {
        context.waitUntil(p);
      },
      request,
      "prices.put",
      "",
      clean.length ? clean.length + " 列" : "清空"
    );
    return json({ ok: true, count: clean.length });
  } catch (e: any) {
    return json({ error: "save-failed", detail: String((e && e.message) || e) }, 500);
  }
}
