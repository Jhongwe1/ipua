// GET /playground — Playground（頁面本體在 src/lib/playgroundpage.ts）。
import { playgroundPageResponse } from "../lib/playgroundpage.js";
import type { RouteCtx } from "../types.js";

export async function onRequestGet({ request, env }: RouteCtx): Promise<Response> {
  return playgroundPageResponse(env, request);
}
