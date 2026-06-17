// Cartero F2b — relay CLIENT helpers (browser + node safe; only `fetch`). The relay SERVER lives
// in src/relay-server.js (node-only) so importing these from the browser doesn't pull in node:http.
//
// The relay is an UNTRUSTED forwarder: a sender publishes the SAME signed+sealed event it commits
// to git; subscribers receive it instantly but MUST gate every delivery (the relay gains no
// authority — a forged payload is rejected exactly like one read from git).

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
