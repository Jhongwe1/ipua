// /api/admin/vpn/channels — 管理員專用：VPN 訂閱的上游渠道管理（2026-07-12 多渠道化）。
//   GET  列出全部渠道（訂閱網址一律遮罩，只回 has_url 與提示；手動節點原文回傳供編輯）
//   POST 新增渠道 { name, kind, url?, nodes?, enabled? }
// kind：sub（機場／自建的上游訂閱網址）或 nodes（手動貼的節點清單，一行一條 vmess:// vless:// …）。
// 會員完全看不到渠道 — 他們只有一條 /vpn/sub/<token>，伺服器把所有啟用中渠道的節點合併送出。
import { json } from "../../../../../lib/site.js";
import { adminOk, keyHint } from "../../../../../lib/auth.js";
import { audit } from "../../../../../lib/observe.js";
import type { RouteCtx } from "../../../../../types.js";

export const KINDS: Record<string, number> = { sub: 1, nodes: 1 };

// 整理後的渠道欄位。url 缺席（undefined）＝「保留舊值」，由呼叫端處理。
export interface VpnChannelInput {
  name: string;
  kind: string;
  nodes: string;
  enabled: number;
  url?: string;
}
export type CleanVpnChannelResult =
  { ch: VpnChannelInput; err?: undefined } | { err: string; ch?: undefined };

// 欄位整理：回 { ch } 或 { err }。

export function cleanChannel(b: any): CleanVpnChannelResult {
  if (!b || typeof b !== "object") return { err: "需要 JSON 本體" };
  const name = String(b.name == null ? "" : b.name)
    .trim()
    .slice(0, 60);
  if (!name) return { err: "名稱不能是空的" };
  const kind = KINDS[b.kind] ? b.kind : "sub";
  const ch: VpnChannelInput = {
    name: name,
    kind: kind,
    nodes: String(b.nodes == null ? "" : b.nodes)
      .trim()
      .slice(0, 20000),
    enabled: b.enabled === false || b.enabled === 0 ? 0 : 1
  };
  if (b.url !== undefined) {
    const u = String(b.url == null ? "" : b.url).trim();
    if (u && !/^https?:\/\/[^\s]+$/.test(u)) return { err: "訂閱網址要是 http(s):// 開頭" };
    ch.url = u.slice(0, 1000);
  }
  if (kind === "sub" && ch.url === "" && b.url !== undefined) return { err: "sub 渠道要填上游訂閱網址" };
  if (kind === "nodes" && !ch.nodes) return { err: "nodes 渠道要貼至少一條節點連結" };
  return { ch: ch };
}

export function maskRow(r: any) {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    enabled: r.enabled,
    created_at: r.created_at,
    has_url: !!r.url,
    url_hint: r.url ? keyHint(r.url) : "",
    nodes: r.nodes || "",
    node_count: r.nodes
      ? r.nodes.split(/\r?\n/).filter(function (s: string) {
          return s.trim();
        }).length
      : 0
  };
}

export async function onRequestGet({ request, env }: RouteCtx): Promise<Response> {
  const url = new URL(request.url);
  if (!(await adminOk(request, env, url))) return json({ error: "unauthorized" }, 401);
  if (!env.DB) return json({ error: "no-db" }, 500);
  try {
    const res = await env.DB.prepare("SELECT * FROM vpn_channels ORDER BY id").all();
    return json({ rows: (res.results || []).map(maskRow) });
  } catch (e: any) {
    return json({ error: "query-failed", detail: String((e && e.message) || e) }, 500);
  }
}

export async function onRequestPost(context: RouteCtx): Promise<Response> {
  const { request, env } = context;
  const url = new URL(request.url);
  if (!(await adminOk(request, env, url))) return json({ error: "unauthorized" }, 401);
  if (!env.DB) return json({ error: "no-db" }, 500);

  let body: any = null;
  try {
    body = await request.json();
  } catch (e) {}
  const c = cleanChannel(body);
  if (c.err !== undefined) return json({ error: "bad-input", hint: c.err }, 400);
  if (c.ch.kind === "sub" && !c.ch.url)
    return json({ error: "bad-input", hint: "sub 渠道要填上游訂閱網址" }, 400);

  try {
    const r = await env.DB.prepare(
      "INSERT INTO vpn_channels (name,kind,url,nodes,enabled,created_at) VALUES (?1,?2,?3,?4,?5,?6)"
    )
      .bind(c.ch.name, c.ch.kind, c.ch.url || "", c.ch.nodes, c.ch.enabled, new Date().toISOString())
      .run();
    // 稽核不落上游網址本體（那等於機場帳號），只記有無
    audit(
      env,
      function (p) {
        context.waitUntil(p);
      },
      request,
      "vpn.channel.create",
      r.meta.last_row_id,
      c.ch.name + " kind=" + c.ch.kind + " 上游網址:" + (c.ch.url ? "有" : "無")
    );
    return json({ id: r.meta.last_row_id });
  } catch (e: any) {
    return json({ error: "insert-failed", detail: String((e && e.message) || e) }, 500);
  }
}
