#!/usr/bin/env node
// Cartero discovery-registry daemon. Binds 127.0.0.1:$PORT (default 8791), behind a reverse proxy.
// Records live under $REGISTRY_DIR. Untrusted: only valid self-signed records are stored; resolvers
// re-verify. See src/registry-server.js.
import { registryServer } from "../src/registry-server.js";

const port = Number(process.env.PORT || 8791);
const host = process.env.HOST || "127.0.0.1";
const dir = process.env.REGISTRY_DIR || "/var/lib/cartero-registry";
const r = await registryServer({ port, host, dir });
console.log(`cartero registry on ${host}:${r.port} (dir ${dir})`);
process.on("SIGTERM", async () => { await r.close(); process.exit(0); });
