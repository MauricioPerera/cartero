// Cartero relay SERVER (node-only — imports node:http). Kept separate from the client helpers
// (src/relay.js) so the browser can import publish/subscribe without pulling in node:http.
//
// An UNTRUSTED forwarder: senders POST the SAME signed+sealed event they commit to git; the relay
// fans it out (SSE) to subscribers of that chat. It never decrypts and gains NO authority — the
// recipient gates every relayed event. Git stays the durable record; the relay is the fast path.

import { createServer } from "node:http";

export function relayServer({ port = 0, host } = {}) {
  const subs = new Map();                                  // chat_id -> Set(res)
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (req.method === "GET" && url.pathname === "/sub") {
      const chat = url.searchParams.get("chat") || "";
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      res.write(":ok\n\n");
      if (!subs.has(chat)) subs.set(chat, new Set());
      subs.get(chat).add(res);
      req.on("close", () => { const s = subs.get(chat); if (s) { s.delete(res); if (!s.size) subs.delete(chat); } });
      return;
    }
    if (req.method === "POST" && url.pathname === "/pub") {
      let b = ""; req.on("data", (c) => { b += c; if (b.length > 4e6) req.destroy(); });
      req.on("end", () => {
        try {
          const { chat, event } = JSON.parse(b);           // opaque to the relay; not inspected/trusted
          for (const r of subs.get(chat) || []) r.write(`data: ${JSON.stringify(event)}\n\n`);
          res.writeHead(204); res.end();
        } catch { res.writeHead(400); res.end(); }
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  return new Promise((resolve) => server.listen(port, host, () => {
    const p = server.address().port;
    resolve({ port: p, url: `http://localhost:${p}`, close: () => new Promise((r) => server.close(r)) });
  }));
}
