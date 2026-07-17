// tools/mock-upstream.mjs — E2E 用的 OpenAI 相容 SSE mock 上游（v2.0.0 Phase M）。
// POST /v1/chat/completions → 固定三段增量＋usage 尾包＋[DONE]（計量掃描有東西可掃）。
// GET /health → 200（playwright webServer 的就緒探針）。
import http from "node:http";

const PORT = parseInt(process.env.MOCK_PORT || "8788", 10);
const REPLY = ["您好", "，這是", " mock 回覆。"];

http
  .createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
      return;
    }
    if (req.method === "POST" && String(req.url).startsWith("/v1/chat/completions")) {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
        for (const c of REPLY) {
          res.write(
            'data: {"model":"mock-model","choices":[{"delta":{"content":' + JSON.stringify(c) + "}}]}\n\n"
          );
        }
        // usage 尾包（stream_options.include_usage 的回應形狀）— relay/playground 計量靠這個
        res.write(
          'data: {"model":"mock-model","choices":[],"usage":{"prompt_tokens":12,"completion_tokens":8}}\n\n'
        );
        res.write("data: [DONE]\n\n");
        res.end();
      });
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end('{"error":"mock-not-found"}');
  })
  .listen(PORT, "127.0.0.1", () => {
    console.log("mock upstream ready on http://127.0.0.1:" + PORT);
  });
