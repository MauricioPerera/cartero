// Cartero F3 — groups end-to-end over THREE REAL outboxes (federated). Run:
//   GH_TOKEN=$(gh auth token) GH_OWNER=MauricioPerera \
//   GH_REPO_A=cartero-test-a GH_REPO_B=cartero-test-b GH_REPO_C=cartero-test-c \
//   node test/group.integration.test.mjs
import { createIdentity, publicIdentityDoc, eventHash } from "../vendor/postal/src/postal.js";
import { outbox, eventPath } from "../src/outbox.js";
import { buildGroupDoc, verifyGroupDoc, buildGm, resolveGroup } from "../src/group.js";
import { encryptFile, decryptFile, makeDescriptor } from "../src/attach.js";

const token = process.env.GH_TOKEN, owner = process.env.GH_OWNER;
const repos = [process.env.GH_REPO_A, process.env.GH_REPO_B, process.env.GH_REPO_C];
if (!token || !owner || repos.some((r) => !r)) { console.error("Set GH_TOKEN, GH_OWNER, GH_REPO_A, GH_REPO_B, GH_REPO_C"); process.exit(2); }

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log("  ok  -", n)) : (fail++, console.error("  FAIL-", n)); };
const T = (i) => `2026-06-18T00:${String(i).padStart(2, "0")}:00.000Z`;

const [alice, bob, carol] = await Promise.all([createIdentity("Alice"), createIdentity("Bob"), createIdentity("Carol")]);
const ids = [alice, bob, carol];
const outs = repos.map((repo) => outbox({ owner, repo, token }));
const uri = (i) => `postal://github.com/${owner}/${repos[i]}`;
const directory = Object.fromEntries(await Promise.all(ids.map(async (x) => [x.id, await publicIdentityDoc(x)])));

console.log(`# cartero group over ${repos.join(", ")}`);
for (let i = 0; i < 3; i++) await outs[i].publishIdentity(directory[ids[i].id]);
ok("each member published its identity to its own outbox", true);

// 1. Alice creates the group (roster = id -> outbox) and publishes the signed doc to her outbox.
const roster = { [alice.id]: uri(0), [bob.id]: uri(1), [carol.id]: uri(2) };
const group = await buildGroupDoc(alice, { name: "proyecto", members: [bob.id, carol.id], roster, created_at: T(0), rnd: "gi" });
await outs[0].publishGroup(group);
ok("group doc published to the creator's outbox", true);

// 2. Bob "joins": fetches the group doc from alice's outbox and verifies it.
const fetched = await outs[0].readGroup(group.id);
ok("a member fetches the group doc from the creator's outbox", fetched && fetched.id === group.id);
ok("the fetched group doc verifies (creator-signed)", await verifyGroupDoc(fetched, { directory }));
ok("roster carries every member's outbox", Object.keys(fetched.roster).length === 3);

// 3. Each member sends a group message to THEIR OWN outbox (sealed to all members).
async function chainOf(out, chat, myId) {
  const mine = (await out.readChat(chat)).filter((it) => it.event.from === myId).sort((x, y) => x.event.seq - y.event.seq);
  return { seq: mine.length, prev: mine.length ? await eventHash(mine[mine.length - 1].event) : null };
}
const enc = await encryptFile(new Uint8Array([1, 2, 3, 4, 5, 250, 99]));
for (const [i, me, text, file] of [[0, alice, "hola equipo 👥", enc], [1, bob, "arranco yo", null], [2, carol, "voy con el front", null]]) {
  const attachments = file ? [makeDescriptor({ name: "p.bin", mime: "application/octet-stream", size: 7, hash: file.hash, key: file.key })] : [];
  const blobs = file ? [outs[i].blobFile(file.hash, file.ct)] : [];
  const c = await chainOf(outs[i], group.id, me.id);
  const ev = await buildGm(me, group, { text, reply_to: null, attachments }, { created_at: T(i + 1), rnd: "m" + i, seq: c.seq, prev: c.prev, directory });
  await outs[i].appendEvent({ path: eventPath(group.id, ev), event: ev }, blobs);
}
ok("all three members posted to their own outboxes", true);

// 4. Carol reads the group = merge of ALL members' outboxes.
const merged = [];
for (let i = 0; i < 3; i++) merged.push(...await outs[i].readChat(group.id));
const convo = await resolveGroup(merged, carol, { groupDoc: group, directory });
ok("group conversation has 3 messages in causal order", convo.length === 3 && convo.map((m) => m.at).join() === [T(1), T(2), T(3)].join());
ok("carol can read every member's sealed message", convo.every((m) => m.readable) && convo[0].text === "hola equipo 👥");
ok("attribution spans the three authors", convo[0].from === alice.id && convo[1].from === bob.id && convo[2].from === carol.id);

// 5. Carol downloads + decrypts alice's group attachment from alice's outbox.
const att = convo.find((m) => m.attachments.length)?.attachments[0];
const ct = await outs[0].getBlob(att.locator);
const got = await decryptFile(ct, att.key, att.hash);
ok("a group attachment round-trips (hash-verified, decrypted)", got.length === 7 && got[5] === 250);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
