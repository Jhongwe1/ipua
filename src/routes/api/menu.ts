// GET /api/menu — 公開：讀側邊欄選單（主站 index.html 用它渲染側邊欄；編輯模式也先讀這支）。
// menu 資料表是空的（還沒自訂過）→ 回內建預設選單，custom:false。
// v2.2：VPN 隱形補到這一支 — 以前這裡回未過濾的選單，/ip /ua 靜態頁的側邊欄
// 對匿名訪客也看得到 VPN（與 SSR 外殼的 filterMenu 不一致）。現在同一套規則：
// 管理員／被批准 vpn 的人，或管理員開了 vpn_public（對外展示）才回 VPN 項。
import { json, DEFAULT_MENU, type MenuItem } from "../../lib/site.js";
import { filterMenu, canSeeVpn } from "../../lib/chrome.js";
import { getSessionUser, adminOk } from "../../lib/auth.js";
import type { RouteCtx } from "../../types.js";

export async function onRequestGet({ request, env }: RouteCtx): Promise<Response> {
  let rows: MenuItem[] = [];
  let vpnPublic = false;
  try {
    const res = await env.DB.batch([
      env.DB.prepare("SELECT kind,label,label_en,url FROM menu ORDER BY pos, id"),
      env.DB.prepare("SELECT v FROM settings WHERE k='vpn_public'")
    ]);
    rows = (res[0].results || []) as unknown as MenuItem[];
    const v = (res[1].results || [])[0] as { v?: string } | undefined;
    vpnPublic = !!v && v.v === "1";
  } catch (e) {
    /* 表未建立 → 預設 */
  }
  const custom = rows.length > 0;
  const items = custom ? rows : DEFAULT_MENU;
  // 管理金鑰（adminbar 的選單編輯器帶 Bearer 打這支）一定要拿到未過濾的完整清單 —
  // 過濾掉的話，編輯器存檔會把 VPN 項整個弄丟。
  if (await adminOk(request, env, new URL(request.url))) return json({ items: items, custom: custom });
  const user = await getSessionUser(request, env);
  return json({ items: filterMenu(items, vpnPublic || canSeeVpn(user, env)), custom: custom });
}
