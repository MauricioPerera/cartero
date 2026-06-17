// Cartero end-to-end over TWO REAL git repos (outbox-per-user). Mirrors what the CLI does:
// each identity publishes to its own outbox, sends sealed DMs there, and the conversation is the
// merge of both. Run:
//   GH_TOKEN=$(gh auth token) GH_OWNER=MauricioPerera GH_REPO_A=cartero-test-a GH_REPO_B=cartero-test-b \
//   node test/integration.test.mjs
import { createIdentity, publicIdentityDoc, eventHash } from "../vendor/postal/src/postal.js";
import { outbox, eventPath } from "../src/outbox.js";
import { buildDm, deriveChatId, resolveConversation } from "../src/convo.js";
import { encryptFile, decryptFile, makeDescriptor } from "../src/attach.js";

const token = process.env.GH_TOKEN, owner = process.env.GH_OWNER;
const repoA = process.env.GH_REPO_A, repoB = process.env.GH_REPO_B;
if (!token || !owner || !repoA || !repoB) { console.error("Set GH_TOKEN, GH_OWNER, GH_REPO_A, GH_REPO_B"); process.exit(2); }

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log("  ok  -", n)) : (fail++, console.error("  FAIL-", n)); };
const T = (i) => `2026-06-17T21:${String(i).padStart(2, "0")}:00.000Z`;

// Fresh identities each run -> fresh derived chat_id -> no collision with prior runs.
const alice = await createIdentity("Alice");
const bob = await createIdentity("Bob");
const aliceDoc = await publicIdentityDoc(alice), bobDoc = await publicIdentityDoc(bob);
const directory = { [alice.id]: aliceDoc, [bob.id]: bobDoc };

const aOut = outbox({ owner, repo: repoA, token });
const bOut = outbox({ owner, repo: repoB, token });
const chat = await deriveChatId(alice.id, bob.id);
console.log(`# cartero over ${owner}/${repoA} + ${owner}/${repoB} (chat ${chat.slice(0, 14)}…)`);

// 1. Each publishes its identity to its own outbox; the peer can resolve+verify it.
await aOut.publishIdentity(aliceDoc);
await bOut.publishIdentity(bobDoc);
ok("bob resolves alice's identity from her outbox", (await aOut.readIdentity(alice.id))?.id === alice.id);
ok("alice resolves bob's identity from his outbox", (await bOut.readIdentity(bob.id))?.id === bob.id);

// helper: next (seq, prev) for my chain in this chat, read fresh from my outbox.
async function chainOf(out, chatId, myId) {
  const mine = (await out.readChat(chatId)).filter((it) => it.event.from === myId).sort((x, y) => x.event.seq - y.event.seq);
  return { seq: mine.length, prev: mine.length ? await eventHash(mine[mine.length - 1].event) : null };
}

// 2. Alice sends a text DM to her own outbox.
let c = await chainOf(aOut, chat, alice.id);
const m1 = await buildDm(alice, bob.id, { text: "hola bob, te paso el doc", reply_to: null, attachments: [] },
  { created_at: T(1), rnd: "m1", seq: c.seq, prev: c.prev, directory });
await aOut.appendEvent({ path: eventPath(chat, m1), event: m1 });
ok("alice's text DM committed to her outbox", true);

// 3. Alice sends an attachment: encrypt -> blob (base64) in her outbox -> sealed descriptor.
const fileBytes = new Uint8Array(Array.from({ length: 64 }, (_, i) => (i * 7 + 3) & 0xff));
const enc = await encryptFile(fileBytes);
const desc = makeDescriptor({ name: "doc.bin", mime: "application/octet-stream", size: fileBytes.length, hash: enc.hash, key: enc.key });
c = await chainOf(aOut, chat, alice.id);
const m2 = await buildDm(alice, bob.id, { text: "ahí va", reply_to: m1.id, attachments: [desc] },
  { created_at: T(2), rnd: "m2", seq: c.seq, prev: c.prev, directory });
await aOut.appendEvent({ path: eventPath(chat, m2), event: m2 }, [aOut.blobFile(enc.hash, enc.ct)]);
ok("alice's attachment DM + blob committed in one commit", true);

// 4. Bob replies from HIS outbox.
c = await chainOf(bOut, chat, bob.id);
const r1 = await buildDm(bob, alice.id, { text: "recibido, gracias!", reply_to: m2.id, attachments: [] },
  { created_at: T(3), rnd: "r1", seq: c.seq, prev: c.prev, directory });
await bOut.appendEvent({ path: eventPath(chat, r1), event: r1 });

// 5. Bob reads the conversation = merge of BOTH outboxes.
const merged = [...await aOut.readChat(chat), ...await bOut.readChat(chat)];
const convo = await resolveConversation(merged, bob, { directory });
ok("conversation has 3 messages in causal order", convo.length === 3 && convo.map((m) => m.at).join() === [T(1), T(2), T(3)].join());
ok("bob can read alice's sealed text", convo[0].text === "hola bob, te paso el doc");
ok("attribution + threading correct", convo[2].from === bob.id && convo[2].reply_to === m2.id);

// 6. Bob downloads + verifies + decrypts the attachment from alice's outbox.
const att = convo.find((m) => m.attachments.length)?.attachments[0];
const ct = await aOut.getBlob(att.locator);
const got = await decryptFile(ct, att.key, att.hash);
ok("attachment round-trips through git (hash-verified, decrypted)", got.length === fileBytes.length && got.every((b, i) => b === fileBytes[i]));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
