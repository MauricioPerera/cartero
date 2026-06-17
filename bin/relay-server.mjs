#!/usr/bin/env node
// Cartero relay daemon. Binds to 127.0.0.1:$PORT (default 8790) — meant to sit BEHIND a reverse
// proxy (nginx) that terminates TLS and exposes /sub + /pub. Untrusted forwarder: see src/relay.js.
import { relayServer } from "../src/relay-server.js";

const port = Number(process.env.PORT || 8790);
const host = process.env.HOST || "127.0.0.1";
const r = await relayServer({ port, host });
console.log(`cartero relay listening on ${host}:${r.port}`);
process.on("SIGTERM", async () => { await r.close(); process.exit(0); });
