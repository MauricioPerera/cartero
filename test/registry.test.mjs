// Cartero F4 — discovery registry (src/registry.js). Deterministic, no network (fetch injected).
// Run: node test/registry.test.mjs
import { createIdentity } from "../vendor/postal/src/postal.js";
import { buildRegistryRecord, verifyRegistryRecord, publishToRegistry, resolveId } from "../src/registry.js";
import { registryServer } from "../src/registry-server.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log("  ok  -", n)) : (fail++, console.error("  FAIL-", n)); };

const alice = await createIdentity("Alice");
const mallory = await createIdentity("Mallory");
const outbox = "postal://github.com/alice/cartero-outbox";

console.log("# build / verify record");
const rec = await buildRegistryRecord(alice, { outbox, updated_at: "2026-06-18T00:00:00.000Z" });
ok("record binds id -> outbox and carries the key", rec.id === alice.id && rec.outbox === outbox && rec.sign_key.pub === alice.sign.publicKey);
ok("a valid record verifies", await verifyRegistryRecord(rec));
ok("a tampered outbox is rejected (sig breaks)", !(await verifyRegistryRecord({ ...rec, outbox: "postal://evil/x" })));
ok("squatting another id is impossible (fingerprint != id)", !(await verifyRegistryRecord({ ...rec, id: mallory.id })));
ok("mallory can't sign alice's id (fingerprint check)", !(await verifyRegistryRecord({ ...rec, sign_key: { alg: "ECDSA-P256", pub: mallory.sign.publicKey } })));

console.log("# publish / resolve against a fake registry (verify-before-store + local verify)");
const store = {};
const fakeRegistry = async (url, opts) => {
  if (opts && opts.method === "POST") {
    const r = JSON.parse(opts.body);
    if (!(await verifyRegistryRecord(r))) return { ok: false, status: 400 };  // server rejects invalid/forged
    store[r.id] = r; return { ok: true, status: 204, json: async () => ({}) };
  }
  const id = url.split("/id/")[1];
  return store[id] ? { ok: true, json: async () => store[id] } : { ok: false, status: 404 };
};
await publishToRegistry("https://reg.example", rec, { fetchImpl: fakeRegistry });
const r = await resolveId("https://reg.example", alice.id, { fetchImpl: fakeRegistry });
ok("a bare id resolves to its outbox", r.id === alice.id && r.outbox === outbox);
ok("an unknown id -> not found", await (async () => { try { await resolveId("https://reg.example", mallory.id, { fetchImpl: fakeRegistry }); return false; } catch (e) { return /not found/.test(e.message); } })());

console.log("# a malicious registry cannot point you at the wrong outbox");
const evilRegistry = async (url) => {                                  // serves a record with a swapped outbox
  const tampered = { ...rec, outbox: "postal://github.com/mallory/evil-outbox" };
  return { ok: true, json: async () => tampered };
};
ok("a server-tampered record is rejected on resolve (local verify)", await (async () => { try { await resolveId("https://evil", alice.id, { fetchImpl: evilRegistry }); return false; } catch { return true; } })());

console.log("# the server rejects forged records at ingest too");
const forged = { ...rec, outbox: "postal://x", sig: rec.sig };          // outbox changed, old sig
let ingestRejected = false;
await publishToRegistry("https://reg.example", forged, { fetchImpl: fakeRegistry }).catch(() => { ingestRejected = true; });
ok("ingest rejects a forged record (HTTP 400)", ingestRejected);

console.log("# real registry server: ingest verify, resolve, anti-replay, traversal-safe");
const dir = mkdtempSync(join(tmpdir(), "cartero-reg-"));
const srv = await registryServer({ port: 0, host: "127.0.0.1", dir });
try {
  await publishToRegistry(srv.url, rec);
  const got = await resolveId(srv.url, alice.id);
  ok("server stores a valid record and resolves it", got.outbox === outbox);
  // forged record rejected at ingest
  let rej = false;
  await publishToRegistry(srv.url, { ...rec, outbox: "postal://x" }).catch(() => { rej = true; });
  ok("server rejects a forged record at ingest", rej);
  // anti-replay: an OLDER record for the same id is refused
  const older = await buildRegistryRecord(alice, { outbox: "postal://github.com/alice/old", updated_at: "2025-01-01T00:00:00.000Z" });
  let replayRej = false;
  await publishToRegistry(srv.url, older).catch(() => { replayRej = true; });
  ok("server refuses an older (replayed) record", replayRej && (await resolveId(srv.url, alice.id)).outbox === outbox);
  // a newer record updates the mapping
  const newer = await buildRegistryRecord(alice, { outbox: "postal://github.com/alice/new", updated_at: "2027-01-01T00:00:00.000Z" });
  await publishToRegistry(srv.url, newer);
  ok("a newer record updates the outbox", (await resolveId(srv.url, alice.id)).outbox === "postal://github.com/alice/new");
  // path-traversal id rejected
  const res = await fetch(srv.url + "/id/" + encodeURIComponent("../../etc/passwd"));
  ok("a traversal id is rejected (400), not served", res.status === 400);
} finally { await srv.close(); rmSync(dir, { recursive: true, force: true }); }

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
