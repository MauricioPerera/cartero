// Cartero F2 — domain handles (src/handle.js). Deterministic, no network (fetch injected).
// Run: node test/handle.test.mjs
import { createIdentity } from "../vendor/postal/src/postal.js";
import { parseHandle, wellKnownUrl, buildHandleDoc, verifyHandleDoc, resolveHandle } from "../src/handle.js";

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log("  ok  -", n)) : (fail++, console.error("  FAIL-", n)); };

const alice = await createIdentity("Alice");
const handle = "alice@perera.dev";
const outbox = "postal://github.com/alice/cartero-outbox";

console.log("# parseHandle / wellKnownUrl");
ok("parses user@domain", JSON.stringify(parseHandle(handle)) === JSON.stringify({ user: "alice", domain: "perera.dev", handle }));
ok("rejects a bare word", (() => { try { parseHandle("alice"); return false; } catch { return true; } })());
ok("rejects a domain without a dot", (() => { try { parseHandle("a@localhost"); return false; } catch { return true; } })());
ok("maps to the .well-known URL", wellKnownUrl(handle) === "https://perera.dev/.well-known/postal/alice.json");

console.log("# buildHandleDoc / verifyHandleDoc");
const doc = await buildHandleDoc(alice, { handle, outbox });
ok("doc binds handle -> id + outbox", doc.handle === handle && doc.id === alice.id && doc.outbox === outbox);
ok("verifies against the typed handle", await verifyHandleDoc(doc, handle));
ok("rejects if the handle claimed differs", !(await verifyHandleDoc({ ...doc, handle: "eve@perera.dev" }, "eve@perera.dev")));
ok("rejects a tampered outbox (sig breaks)", !(await verifyHandleDoc({ ...doc, outbox: "postal://evil/x#y" }, handle)));
ok("rejects a forged id (fingerprint mismatch)", !(await verifyHandleDoc({ ...doc, id: "0000000000000000" }, handle)));

console.log("# resolveHandle (injected fetch = the domain serving .well-known)");
const serve = (table) => async (url) => {
  const body = table[url];
  return body ? { ok: true, json: async () => body } : { ok: false, status: 404, json: async () => ({}) };
};
const fetchImpl = serve({ [wellKnownUrl(handle)]: doc });
const resolved = await resolveHandle(handle, { fetchImpl });
ok("resolves to id + outbox", resolved.id === alice.id && resolved.outbox === outbox && resolved.handle === handle);
ok("404 -> throws not found", await (async () => { try { await resolveHandle("ghost@perera.dev", { fetchImpl }); return false; } catch (e) { return /not found/.test(e.message); } })());

console.log("# a domain cannot serve a binding for a handle it doesn't own");
// eve hosts at evil.com a doc that claims alice@perera.dev — fetched from evil.com it still must
// claim its OWN domain; the verifier checks doc.domain == the handle's domain.
const crossDoc = await buildHandleDoc(alice, { handle: "alice@evil.com", outbox });
ok("a doc for @evil.com fails when looked up as @perera.dev", !(await verifyHandleDoc(crossDoc, "alice@perera.dev")));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
