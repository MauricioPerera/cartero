// Cartero F3 — group core (src/group.js). In memory, no network. Run: node test/group.test.mjs
import { createIdentity, publicIdentityDoc, buildEvent, eventPath } from "../vendor/postal/src/postal.js";
import { buildGroupDoc, verifyGroupDoc, buildGm, openGm, verifyGm, resolveGroup } from "../src/group.js";

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log("  ok  -", n)) : (fail++, console.error("  FAIL-", n)); };

const alice = await createIdentity("Alice");   // creator
const bob = await createIdentity("Bob");
const carol = await createIdentity("Carol");
const mallory = await createIdentity("Mallory"); // outsider
const directory = Object.fromEntries(await Promise.all(
  [alice, bob, carol, mallory].map(async (i) => [i.id, await publicIdentityDoc(i)])));
const T = (i) => `2026-06-17T23:${String(i).padStart(2, "0")}:00.000Z`;
const item = (ev) => ({ path: eventPath(ev.chat_id, ev), event: ev });

console.log("# group doc");
const group = await buildGroupDoc(alice, { name: "proyecto", members: [bob.id, carol.id], created_at: T(0), rnd: "g1" });
ok("id anchored to creator + members include creator", group.id === `grp_${alice.id}_g1` && group.members.includes(alice.id) && group.members.length === 3);
ok("valid group doc verifies", await verifyGroupDoc(group, { directory }));
ok("tampered member list rejected (sig breaks)", !(await verifyGroupDoc({ ...group, members: [...group.members, mallory.id] }, { directory })));
ok("unknown creator rejected", !(await verifyGroupDoc(group, { directory: {} })));

console.log("# sealed group message: all members read, outsider can't");
const gm = await buildGm(alice, group, { text: "hola equipo 👥", reply_to: null, attachments: [] },
  { created_at: T(1), rnd: "m1", seq: 0, prev: null, directory });
ok("event is a sealed gm to the group", gm.kind === "gm" && gm.chat_id === group.id && !JSON.stringify(gm.body).includes("hola equipo"));
ok("bob reads it", (await openGm(gm, bob)).text === "hola equipo 👥");
ok("carol reads it", (await openGm(gm, carol)).text === "hola equipo 👥");
ok("alice (sender) reads her own", (await openGm(gm, alice)).text === "hola equipo 👥");
ok("outsider mallory CANNOT open it", await (async () => { try { await openGm(gm, mallory); return false; } catch { return true; } })());

console.log("# the group gate");
ok("valid gm passes", (await verifyGm(gm, { groupDoc: group, directory })).ok);
const intruder = await buildEvent(mallory, { kind: "gm", chat_id: group.id, to: [alice.id], created_at: T(2), rnd: "x", body: { sealed: "POSTAL1:x" }, seq: 0, prev: null });
ok("a non-member's gm is rejected (author-not-member)", (await verifyGm(intruder, { groupDoc: group, directory })).reasons.includes("author-not-member"));
const wrongGroup = await buildEvent(bob, { kind: "gm", chat_id: "grp_" + bob.id + "_zz", to: [alice.id], created_at: T(3), rnd: "w", body: { sealed: "POSTAL1:x" }, seq: 0, prev: null });
ok("a gm for another group is rejected (wrong-group)", (await verifyGm(wrongGroup, { groupDoc: group, directory })).reasons.includes("wrong-group"));

console.log("# resolve = merge of members' outboxes, causal order");
const bobMsg = await buildGm(bob, group, { text: "arranco yo", reply_to: gm.id, attachments: [] }, { created_at: T(2), rnd: "b1", seq: 0, prev: null, directory });
const carolMsg = await buildGm(carol, group, { text: "voy con el front", reply_to: gm.id, attachments: [] }, { created_at: T(3), rnd: "c1", seq: 0, prev: null, directory });
const merged = [item(gm), item(carolMsg), item(bobMsg)];                 // three outboxes, unordered
const convo = await resolveGroup(merged, carol, { groupDoc: group, directory });
ok("all three messages resolve, in time order", convo.length === 3 && convo.map((m) => m.at).join() === [T(1), T(2), T(3)].join());
ok("attribution correct (alice, bob, carol)", convo[0].from === alice.id && convo[1].from === bob.id && convo[2].from === carol.id && convo[2].mine);

console.log("# a forged gm copying a real id must not suppress the real one (seenPaths)");
const forgedBob = { ...bobMsg, sig: bobMsg.sig.slice(0, -2) + (bobMsg.sig.endsWith("zz") ? "aa" : "zz") };
const sup = await resolveGroup([item(forgedBob), item(bobMsg)], carol, { groupDoc: group, directory });
ok("real gm survives even when the forgery (same id) is processed first", sup.filter((m) => m.text === "arranco yo").length === 1);

console.log("# removed member: a message from someone not in the doc is dropped");
const smallGroup = await buildGroupDoc(alice, { name: "proyecto", members: [bob.id], created_at: T(0), rnd: "g2" });  // carol removed
// carol tries to post to the original group id but the reader uses smallGroup (carol not a member)
const carolToSmall = await buildGm(carol, { ...group, id: smallGroup.id }, { text: "sigo acá?", reply_to: null, attachments: [] },
  { created_at: T(4), rnd: "c2", seq: 0, prev: null, directory });
const after = await resolveGroup([item(carolToSmall)], bob, { groupDoc: smallGroup, directory });
ok("the removed member's message does not appear", after.length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
