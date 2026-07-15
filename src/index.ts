// src/index.ts — Workers 進入點（v2.0.0 Phase D）。
// export default { fetch }：所有請求進 router.handle；靜態資產與 SPA fallback 由
// wrangler.toml 的 [assets]（binding=ASSETS, not_found_handling=single-page-application）
// 提供，router 找不到路由時 fetch 它。功能邏輯全在 functions/ 既有 handler，此處只轉交。
import { handle, type Env } from "./router.js";

export default {
  fetch(request: Request, env: Env, exec: ExecutionContext): Promise<Response> {
    return handle(request, env, exec);
  }
};
