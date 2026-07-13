// GET /playground — LLM Playground（頁面本體在 lib/playgroundpage.js）。
import { playgroundPageResponse } from "../lib/playgroundpage.js";

export async function onRequestGet({ env }) {
  return playgroundPageResponse(env);
}
