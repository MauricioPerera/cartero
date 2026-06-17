// Cartero F3 — multi-device wired END-TO-END through the DM flow (convo.js + device.js).
// A device reads messages sealed to its owner AND sends as the owner; the gate accepts it.
// Run: node test/multidevice.test.mjs
import { createIdentity, publicIdentityDoc } from "../vendor/postal/src/postal.js";
import { buildDeviceCert } from "../src/device.js";
import { buildDm, openDm, verifyDm } from "../src/convo.js";

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log("  ok  -", n)) : (fail++, console.error("  FAIL-", n)); };

const alice = await createIdentity("Alice");
const bob = await createIdentity("Bob");                 // bob's MASTER identity (id = bob)
const bobPhone = await createIdentity("Bob-phone");      // a 2nd device's keypair
const bobLaptop = await createIdentity("Bob-laptop");    // a 3rd device
const mallory = await createIdentity("Mallory");

// bob's master certifies the phone (and laptop). The directory carries the certs on bob's doc.
const certPhone = await buildDeviceCert(bob, bobPhone, { name: "phone", created_at: "2026-06-18T00:00:00.000Z" });
const aliceDoc = await publicIdentityDoc(alice);
const bobDoc = { ...await publicIdentityDoc(bob), devices: [certPhone] };
const directory = { [alice.id]: aliceDoc, [bob.id]: bobDoc };

// A device acts AS the identity: id = the master id, but its OWN sign/enc keys.
const phoneId = { id: bob.id, sign: bobPhone.sign, enc: bobPhone.enc };
const masterId = { id: bob.id, sign: bob.sign, enc: bob.enc };

console.log("# alice -> bob: sealed to bob's master AND device, so either reads");
const m1 = await buildDm(alice, bob.id, { text: "hola bob (multi-device)", reply_to: null, attachments: [] },
  { created_at: "2026-06-18T00:01:00.000Z", rnd: "a1", seq: 0, prev: null, directory });
ok("bob's MASTER reads it", (await openDm(m1, masterId)).text === "hola bob (multi-device)");
ok("bob's PHONE (a certified device) reads it too", (await openDm(m1, phoneId)).text === "hola bob (multi-device)");
ok("an uncertified key (mallory) still cannot read", await (async () => { try { await openDm(m1, { id: bob.id, sign: mallory.sign, enc: mallory.enc }); return false; } catch { return true; } })());

console.log("# bob's PHONE sends as bob; alice's gate accepts the device signature");
const m2 = await buildDm(phoneId, alice.id, { text: "respondo desde el teléfono", reply_to: m1.id, attachments: [] },
  { created_at: "2026-06-18T00:02:00.000Z", rnd: "p1", seq: 1, prev: null, directory });
ok("the event is authored as bob (the identity), not the device", m2.from === bob.id);
ok("alice's gate ACCEPTS the device-signed event", (await verifyDm(m2, { directory })).ok);
ok("alice reads the phone's message", (await openDm(m2, { id: alice.id, sign: alice.sign, enc: alice.enc })).text === "respondo desde el teléfono");

console.log("# security: an UNcertified device is rejected by the gate");
const rogue = { id: bob.id, sign: mallory.sign, enc: mallory.enc };   // claims to be bob, no cert
const m3 = await buildDm(rogue, alice.id, { text: "soy bob (mentira)", reply_to: null, attachments: [] },
  { created_at: "2026-06-18T00:03:00.000Z", rnd: "r1", seq: 0, prev: null, directory });
ok("an uncertified device impersonating bob is REJECTED", !(await verifyDm(m3, { directory })).ok);
ok("rejection reason is the signature", (await verifyDm(m3, { directory })).reasons.includes("invalid-signature"));

console.log("# without certs (single-device), bob's master still works and the phone is rejected");
const dirNoCerts = { [alice.id]: aliceDoc, [bob.id]: await publicIdentityDoc(bob) };
const m4 = await buildDm(masterId, alice.id, { text: "solo master", reply_to: null, attachments: [] },
  { created_at: "2026-06-18T00:04:00.000Z", rnd: "m4", seq: 0, prev: null, directory: dirNoCerts });
ok("master-signed event still verifies with no certs", (await verifyDm(m4, { directory: dirNoCerts })).ok);
ok("a device-signed event is rejected when its cert isn't published", !(await verifyDm(m2, { directory: dirNoCerts })).ok);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
