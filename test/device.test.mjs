// Cartero F3 — multi-device core (src/device.js). In memory. Run: node test/device.test.mjs
import { createIdentity, publicIdentityDoc, buildEvent } from "../vendor/postal/src/postal.js";
import { buildDeviceCert, verifyDeviceCert, authorizedSignKeys, recipientEncKeys, verifyDeviceSignedEvent } from "../src/device.js";

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log("  ok  -", n)) : (fail++, console.error("  FAIL-", n)); };

const master = await createIdentity("Bob");          // the identity (id = master fingerprint)
const phone = await createIdentity("Bob-phone");     // a 2nd device's keypair (its own keys)
const laptop = await createIdentity("Bob-laptop");   // a 3rd device
const attacker = await createIdentity("Mallory");
const masterDoc = await publicIdentityDoc(master);

console.log("# device certs");
const certPhone = await buildDeviceCert(master, phone, { name: "phone", created_at: "2026-06-18T00:00:00.000Z" });
const certLaptop = await buildDeviceCert(master, laptop, { name: "laptop", created_at: "2026-06-18T00:00:00.000Z" });
ok("cert names the identity + carries device keys", certPhone.identity === master.id && certPhone.device_sign === phone.sign.publicKey);
ok("a valid cert verifies against the master", await verifyDeviceCert(certPhone, masterDoc));
ok("a cert signed by someone else is rejected", !(await verifyDeviceCert({ ...certPhone, sig: (await buildDeviceCert(attacker, phone, {})).sig }, masterDoc)));
ok("a cert claiming another identity is rejected", !(await verifyDeviceCert({ ...certPhone, identity: attacker.id }, masterDoc)));

console.log("# authorized keys derivation");
const signKeys = await authorizedSignKeys(masterDoc, [certPhone, certLaptop]);
ok("authorized sign keys = master + 2 devices", signKeys.length === 3 && signKeys.includes(master.sign.publicKey) && signKeys.includes(phone.sign.publicKey));
const encKeys = await recipientEncKeys(masterDoc, [certPhone, certLaptop]);
ok("recipient enc keys = master + 2 devices (seal to all so any device reads)", encKeys.length === 3 && encKeys.includes(masterDoc.enc_key.pub) && encKeys.includes(phone.enc.publicKey));
ok("a forged cert in the set is ignored, not trusted", (await authorizedSignKeys(masterDoc, [certPhone, { ...certLaptop, device_sign: attacker.sign.publicKey }])).length === 2);

console.log("# device-signed event is accepted as the identity (no postal-core change)");
// The device acts AS the identity: from = master.id, but signed by the DEVICE key.
const deviceIdentity = { id: master.id, sign: phone.sign, enc: phone.enc };
const ev = await buildEvent(deviceIdentity, { kind: "dm", chat_id: "dm_x", to: ["peer"], created_at: "2026-06-18T00:01:00.000Z", rnd: "d1", body: { hi: 1 }, seq: 0, prev: null });
ok("event is authored as the master id", ev.from === master.id);
ok("a certified device's signature is accepted for the identity", await verifyDeviceSignedEvent(ev, masterDoc, [certPhone, certLaptop]));

const masterIdentity = { id: master.id, sign: master.sign, enc: master.enc };
const evMaster = await buildEvent(masterIdentity, { kind: "dm", chat_id: "dm_x", to: ["peer"], created_at: "2026-06-18T00:02:00.000Z", rnd: "d2", body: { hi: 2 }, seq: 1, prev: null });
ok("the master's own signature is still accepted", await verifyDeviceSignedEvent(evMaster, masterDoc, [certPhone]));

const rogueIdentity = { id: master.id, sign: attacker.sign, enc: attacker.enc };  // claims to be bob, not certified
const evRogue = await buildEvent(rogueIdentity, { kind: "dm", chat_id: "dm_x", to: ["peer"], created_at: "2026-06-18T00:03:00.000Z", rnd: "d3", body: { hi: 3 }, seq: 0, prev: null });
ok("an UNcertified device/key is rejected (impersonation blocked)", !(await verifyDeviceSignedEvent(evRogue, masterDoc, [certPhone, certLaptop])));
ok("with no certs, only the master key is accepted", await verifyDeviceSignedEvent(evMaster, masterDoc, []) && !(await verifyDeviceSignedEvent(ev, masterDoc, [])));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
