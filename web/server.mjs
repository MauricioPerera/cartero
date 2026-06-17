#!/usr/bin/env node
// Cartero web UI — a tiny static server. It serves web/index.html and the project's ESM modules
// by their real relative paths (so the browser can `import` src/* and vendor/postal/src/* exactly
// as they import each other). The browser does ALL the work: generates the identity, signs/seals,
// talks to GitHub (the user's token) and the relay directly. The server holds no secrets.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, sep, extname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(join(here, ".."));                 // the cartero project dir
const PORT = process.env.PORT || 8765;
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".cjs": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".css": "text/css; charset=utf-8" };

createServer(async (req, res) => {
  const url = decodeURIComponent(req.url.split("?")[0]);
  const rel = url === "/" ? "web/index.html" : url.replace(/^\/+/, "");
  const full = resolve(join(ROOT, rel));
  if (full !== ROOT && !full.startsWith(ROOT + sep)) { res.writeHead(403); res.end("forbidden"); return; }
  try {
    const body = await readFile(full);
    res.writeHead(200, { "Content-Type": TYPES[extname(full)] || "application/octet-stream" });
    res.end(body);
  } catch { res.writeHead(404); res.end("not found"); }
}).listen(PORT, () => console.log(`cartero web UI on http://localhost:${PORT}`));
