// Cartero F2b — the relay: an UNTRUSTED forwarder for near-real-time delivery. Senders POST the
// SAME signed+sealed event they commit to git; the relay fans it out (SSE) to subscribers of that
// chat instantly. The relay never decrypts (ciphertext) and never gains authority: the recipient
// runs the gate (verifyDm) on every relayed event, so a malicious/forged relay payload is rejected
// exactly like one read from git. Git stays the durable record; the relay is just the fast path.
//
// HONEST SCOPE: this is the relay-DIRECT path (sender -> relay -> recipient), fully usable offline.
// Triggering delivery from a git push (GitHub webhook -> relay) needs the relay on a PUBLIC URL +
// the webhook secret/HMAC; that half is deferred (config/hosting), not built here.

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
      req.on("close", () => subs.get(chat)?.delete(res));
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

// Publisher: push an event to the relay (best-effort; failure never blocks the git write).
export async function publish(relayUrl, chat, event) {
  try { await fetch(relayUrl + "/pub", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat, event }) }); return true; }
  catch { return false; }
}

// Subscriber: stream events for a chat. Calls onEvent(rawEvent) per delivery (UNVERIFIED — the
// caller MUST gate it). Returns when the stream ends or `signal` aborts.
export async function subscribe(relayUrl, chat, onEvent, { signal } = {}) {
  const res = await fetch(`${relayUrl}/sub?chat=${encodeURIComponent(chat)}`, { signal });
  const reader = res.body.getReader(), dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const line = buf.slice(0, i).split("\n").find((l) => l.startsWith("data: "));
      buf = buf.slice(i + 2);
      if (line) { try { onEvent(JSON.parse(line.slice(6))); } catch {} }
    }
  }
}
