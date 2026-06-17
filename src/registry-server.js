// Cartero F4 — discovery registry SERVER (node-only: http + fs). Stores SELF-SIGNED id->outbox
// records and serves them. It VERIFIES every record at ingest (only valid, self-signed records are
// stored — no squatting, no records under someone else's id) and enforces a monotonic updated_at
// (anti-replay). It is still untrusted: resolvers re-verify locally, so it can't forge a mapping.
//
//   POST /register   { v,id,sign_key,outbox,updated_at,sig }  -> 204 / 400 / 409
//   GET  /id/<id>                                             -> the record / 404

import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { verifyRegistryRecord } from "./registry.js";

const ID_RE = /^[A-Fa-f0-9]{16}$/;   // id = 64-bit fingerprint; constrain it before use as a filename

export function registryServer({ port = 0, host, dir } = {}) {
  const DIR = dir || process.env.REGISTRY_DIR || "/tmp/cartero-registry";
  const recPath = (id) => join(DIR, id + ".json");

  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (req.method === "POST" && url.pathname === "/register") {
      let b = ""; req.on("data", (c) => { b += c; if (b.length > 1e5) req.destroy(); });
      req.on("end", async () => {
        try {
          const rec = JSON.parse(b);
          if (!ID_RE.test(rec.id || "") || !(await verifyRegistryRecord(rec))) { res.writeHead(400); return res.end("invalid record"); }
          const prev = await readFile(recPath(rec.id), "utf8").then(JSON.parse).catch(() => null);
          if (prev && String(rec.updated_at || "") <= String(prev.updated_at || "")) { res.writeHead(409); return res.end("not newer"); }
          await mkdir(DIR, { recursive: true });
          await writeFile(recPath(rec.id), JSON.stringify(rec));
          res.writeHead(204); res.end();
        } catch { res.writeHead(400); res.end("bad json"); }
      });
      return;
    }
    const m = url.pathname.match(/^\/id\/([^/]+)$/);
    if (req.method === "GET" && m) {
      const id = decodeURIComponent(m[1]);
      if (!ID_RE.test(id)) { res.writeHead(400); return res.end(); }
      readFile(recPath(id), "utf8")
        .then((rec) => { res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }); res.end(rec); })
        .catch(() => { res.writeHead(404); res.end(); });
      return;
    }
    res.writeHead(404); res.end();
  });

  return new Promise((resolve) => server.listen(port, host, () => {
    const p = server.address().port;
    resolve({ port: p, url: `http://localhost:${p}`, close: () => new Promise((r) => server.close(r)) });
  }));
}
