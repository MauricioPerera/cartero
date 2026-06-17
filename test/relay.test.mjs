// Cartero F2b — relay forward + gate-on-receipt (src/relay.js). Local only (no GitHub).
// Proves the relay is UNTRUSTED: it forwards anything, but the recipient's gate drops forgeries.
// Run: node test/relay.test.mjs
import { createIdentity, publicIdentityDoc } from "../vendor/postal/src/postal.js";
import { relayServer } from "../src/relay-server.js";
import { publish, subscribe } from "../src/relay.js";
import { buildDm, deriveChatId, verifyDm, openDm } from "../src/convo.js";

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log("  ok  -", n)) : (fail++, console.error("  FAIL-", n)); };
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const alice = await createIdentity("Alice");
const bob = await createIdentity("Bob");
const directory = { [alice.id]: await publicIdentityDoc(alice), [bob.id]: await publicIdentityDoc(bob) };
const chat = await deriveChatId(alice.id, bob.id);

// A real DM and a forged copy (broken signature).
const real = await buildDm(alice, bob.id, { text: "hola en tiempo real ⚡", reply_to: null, attachments: [] },
  { created_at: "2026-06-17T22:00:00.000Z", rnd: "rt1", seq: 0, prev: null, directory });
const forged = { ...real, sig: real.sig.slice(0, -4) + (real.sig.endsWith("AAAA") ? "BBBB" : "AAAA") };

const relay = await relayServer({ port: 0 });
console.log(`# relay on ${relay.url} (untrusted forwarder)`);

const received = [];
const ac = new AbortController();
subscribe(relay.url, chat, (ev) => received.push(ev), { signal: ac.signal }).catch(() => {});
await delay(150);                                          // let bob's subscription register

await publish(relay.url, chat, real);
await publish(relay.url, chat, forged);
await delay(150);
ac.abort();
await relay.close();

ok("relay forwarded BOTH events (it doesn't judge)", received.length === 2);

// Bob gates every relayed event before trusting it.
const accepted = [];
for (const ev of received) if ((await verifyDm(ev, { directory })).ok) accepted.push(ev);
ok("only the valid event passes the gate on receipt", accepted.length === 1 && accepted[0].id === real.id);
ok("the forged relayed event is rejected (relay gains no authority)", !accepted.some((e) => e.sig === forged.sig));
ok("bob can decrypt the real relayed event instantly", accepted.length === 1 && (await openDm(accepted[0], bob)).text === "hola en tiempo real ⚡");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
