// src/routes.ts — 路由表（v2.0.0 Phase D）。註冊順序＝優先序（線性掃描，第一個命中者勝）。
// 每列 [樣式, { 方法: handler }]；ALL＝onRequest（所有方法，relay/vpn 轉發用）。
// 靜態 import 全部 functions/ handler —— 檔案原地不動，同一 commit 可回滾回 Pages。
//
// 排序原則：靜態頁與 API 在前、單段動態（:id/:slug）居中、catch-all（*path）最後。
// 因為各路由的字面段幾乎不重疊，實際上只有 relay 的 *path 需要墊底。

import type { MethodMap } from "./router.js";

// —— 頂層頁面 ——
import { onRequestGet as home } from "../functions/index.js";
import { onRequestGet as feed } from "../functions/feed.js";
import { onRequestGet as sitemap } from "../functions/sitemap.js";
import { onRequestGet as adminPage } from "../functions/admin.js";
import { onRequestGet as apiDocs } from "../functions/api-docs.js";
import { onRequestGet as logsPage } from "../functions/logs.js";
import { onRequestGet as membersPage } from "../functions/members.js";
import { onRequestGet as playgroundPage } from "../functions/playground.js";

// —— 內容頁 ——
import { onRequestGet as newsList } from "../functions/news/index.js";
import { onRequestGet as newsItem } from "../functions/news/[id].js";
import { onRequestGet as articlesList } from "../functions/articles/index.js";
import { onRequestGet as articlesItem } from "../functions/articles/[id].js";
import { onRequestGet as customPage } from "../functions/p/[slug].js";
import { onRequestGet as imgGet } from "../functions/img/[id].js";

// —— auth ——
import { onRequestGet as loginGet, onRequestPost as loginPost } from "../functions/auth/login.js";
import { onRequestGet as logoutGet, onRequestPost as logoutPost } from "../functions/auth/logout.js";
import { onRequestGet as authCallback } from "../functions/auth/callback.js";

// —— VPN（頁＋訂閱） ——
import { onRequestGet as vpnPage } from "../functions/vpn/index.js";
import { onRequestGet as vpnSub } from "../functions/vpn/sub/[token].js";

// —— relay 轉發（catch-all；也接 /relay 本身＝操作頁） ——
import { onRequest as relayAll } from "../functions/relay/[[path]].js";

// —— 公開 API ——
import { onRequestGet as apiHealth } from "../functions/api/health.js";
import { onRequestGet as apiWhoami } from "../functions/api/whoami.js";
import { onRequestGet as apiMe } from "../functions/api/me.js";
import { onRequestGet as apiMenu } from "../functions/api/menu.js";
import { onRequestGet as apiSettings } from "../functions/api/settings.js";
import { onRequestGet as apiLogs } from "../functions/api/logs.js";
import { onRequestPost as apiCspReport } from "../functions/api/csp-report.js";
import { onRequestGet as apiArticlesList } from "../functions/api/articles/index.js";
import { onRequestGet as apiArticleGet } from "../functions/api/articles/[id].js";
import { onRequestGet as apiPagesList } from "../functions/api/pages/index.js";
import { onRequestGet as apiPageGet } from "../functions/api/pages/[slug].js";
import { onRequestGet as apiRelayChannels } from "../functions/api/relay/channels.js";
import { onRequestGet as apiPgModels } from "../functions/api/playground/models.js";
import { onRequestPost as apiPgChat } from "../functions/api/playground/chat.js";
import { onRequestGet as apiPgConvList } from "../functions/api/playground/conversations/index.js";
import {
  onRequestGet as apiPgConvGet, onRequestPut as apiPgConvPut, onRequestDelete as apiPgConvDel
} from "../functions/api/playground/conversations/[id].js";

// —— 會員自助 API ——
import { onRequestPost as acctKeyPost, onRequestDelete as acctKeyDel } from "../functions/api/account/key.js";
import { onRequestPost as acctVpnToken } from "../functions/api/account/vpn-token.js";
import { onRequestPost as acctLogoutAll } from "../functions/api/account/logout-all.js";

// —— 站長 API ——
import { onRequestGet as admApidoc } from "../functions/api/admin/apidoc.js";
import { onRequestGet as admErrorsGet, onRequestDelete as admErrorsDel } from "../functions/api/admin/errors.js";
import { onRequestPost as admMedia } from "../functions/api/admin/media.js";
import { onRequestPut as admMenu } from "../functions/api/admin/menu.js";
import { onRequestPut as admSettings } from "../functions/api/admin/settings.js";
import { onRequestGet as admStats } from "../functions/api/admin/stats.js";
import { onRequestGet as admArtList, onRequestPost as admArtCreate } from "../functions/api/admin/articles/index.js";
import {
  onRequestGet as admArtGet, onRequestPut as admArtPut, onRequestDelete as admArtDel
} from "../functions/api/admin/articles/[id].js";
import { onRequestGet as admPagesList, onRequestPost as admPagesCreate } from "../functions/api/admin/pages/index.js";
import {
  onRequestGet as admPageGet, onRequestPut as admPagePut, onRequestDelete as admPageDel
} from "../functions/api/admin/pages/[key].js";
import { onRequestGet as admUsersList } from "../functions/api/admin/users/index.js";
import { onRequestPut as admUserPut, onRequestDelete as admUserDel } from "../functions/api/admin/users/[id].js";
import {
  onRequestGet as admRelayChList, onRequestPost as admRelayChCreate
} from "../functions/api/admin/relay/channels/index.js";
import {
  onRequestPut as admRelayChPut, onRequestDelete as admRelayChDel
} from "../functions/api/admin/relay/channels/[id].js";
import {
  onRequestGet as admVpnChList, onRequestPost as admVpnChCreate
} from "../functions/api/admin/vpn/channels/index.js";
import {
  onRequestPut as admVpnChPut, onRequestDelete as admVpnChDel
} from "../functions/api/admin/vpn/channels/[id].js";

// handler 們的型別在 .js 端是寬鬆的；這裡統一當成 MethodMap 的值。
type H = MethodMap[string];
const G = (fn: unknown): MethodMap => ({ GET: fn as H });

export const ROUTES: Array<[string, MethodMap]> = [
  // 站長內容 API（放最前面，確保 :id/:slug 段不被別的規則搶）
  ["/api/admin/apidoc", G(admApidoc)],
  ["/api/admin/errors", { GET: admErrorsGet as H, DELETE: admErrorsDel as H }],
  ["/api/admin/media", { POST: admMedia as H }],
  ["/api/admin/menu", { PUT: admMenu as H }],
  ["/api/admin/settings", { PUT: admSettings as H }],
  ["/api/admin/stats", G(admStats)],
  ["/api/admin/articles", { GET: admArtList as H, POST: admArtCreate as H }],
  ["/api/admin/articles/:id", { GET: admArtGet as H, PUT: admArtPut as H, DELETE: admArtDel as H }],
  ["/api/admin/pages", { GET: admPagesList as H, POST: admPagesCreate as H }],
  ["/api/admin/pages/:key", { GET: admPageGet as H, PUT: admPagePut as H, DELETE: admPageDel as H }],
  ["/api/admin/users", G(admUsersList)],
  ["/api/admin/users/:id", { PUT: admUserPut as H, DELETE: admUserDel as H }],
  ["/api/admin/relay/channels", { GET: admRelayChList as H, POST: admRelayChCreate as H }],
  ["/api/admin/relay/channels/:id", { PUT: admRelayChPut as H, DELETE: admRelayChDel as H }],
  ["/api/admin/vpn/channels", { GET: admVpnChList as H, POST: admVpnChCreate as H }],
  ["/api/admin/vpn/channels/:id", { PUT: admVpnChPut as H, DELETE: admVpnChDel as H }],

  // 會員自助 API
  ["/api/account/key", { POST: acctKeyPost as H, DELETE: acctKeyDel as H }],
  ["/api/account/vpn-token", { POST: acctVpnToken as H }],
  ["/api/account/logout-all", { POST: acctLogoutAll as H }],

  // 公開 API
  ["/api/health", G(apiHealth)],
  ["/api/whoami", G(apiWhoami)],
  ["/api/me", G(apiMe)],
  ["/api/menu", G(apiMenu)],
  ["/api/settings", G(apiSettings)],
  ["/api/logs", G(apiLogs)],
  ["/api/csp-report", { POST: apiCspReport as H }],
  ["/api/articles", G(apiArticlesList)],
  ["/api/articles/:id", G(apiArticleGet)],
  ["/api/pages", G(apiPagesList)],
  ["/api/pages/:slug", G(apiPageGet)],
  ["/api/relay/channels", G(apiRelayChannels)],
  ["/api/playground/models", G(apiPgModels)],
  ["/api/playground/chat", { POST: apiPgChat as H }],
  ["/api/playground/conversations", G(apiPgConvList)],
  ["/api/playground/conversations/:id", { GET: apiPgConvGet as H, PUT: apiPgConvPut as H, DELETE: apiPgConvDel as H }],

  // auth
  ["/auth/login", { GET: loginGet as H, POST: loginPost as H }],
  ["/auth/logout", { GET: logoutGet as H, POST: logoutPost as H }],
  ["/auth/callback", G(authCallback)],

  // 頂層頁面
  ["/", G(home)],
  ["/feed", G(feed)],
  ["/sitemap", G(sitemap)],
  ["/admin", G(adminPage)],
  ["/api-docs", G(apiDocs)],
  ["/logs", G(logsPage)],
  ["/members", G(membersPage)],
  ["/playground", G(playgroundPage)],

  // 內容頁（單段動態）
  ["/news", G(newsList)],
  ["/news/:id", G(newsItem)],
  ["/articles", G(articlesList)],
  ["/articles/:id", G(articlesItem)],
  ["/p/:slug", G(customPage)],
  ["/img/:id", G(imgGet)],

  // VPN
  ["/vpn", G(vpnPage)],
  ["/vpn/sub/:token", G(vpnSub)],

  // relay catch-all（墊底）：也接 /relay 本身＝操作頁
  ["/relay/*path", { ALL: relayAll as H }],
  ["/relay", { ALL: relayAll as H }]
];
