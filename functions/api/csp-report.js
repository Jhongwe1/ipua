// POST /api/csp-report — CSP 違規回報收集端（瀏覽器自動 POST，無認證）。
// 防灌爆：10% 取樣＋長度截斷＋永遠回 204（不給探測者任何資訊）。
// 進 errlog（src:'csp'），在 /logs 錯誤分頁看得到 — CSP 政策壞了第一時間知道。
import { reportErrorNow } from "../../lib/observe.js";

export async function onRequestPost({ request, env }) {
  try {
    if (Math.random() < 0.1) {
      const raw = String(await request.text()).slice(0, 2000);
      let brief = raw;
      try {
        const j = JSON.parse(raw);
        const r = j["csp-report"] || j;
        brief = (r["violated-directive"] || r.violatedDirective || "?") + " @ " +
                (r["document-uri"] || r.documentURI || "?") + " ← " +
                (r["blocked-uri"] || r.blockedURI || "?");
      } catch (e) {}
      await reportErrorNow(env, "csp", brief.slice(0, 500), { detail: raw });
    }
  } catch (e) {}
  return new Response(null, { status: 204 });
}
