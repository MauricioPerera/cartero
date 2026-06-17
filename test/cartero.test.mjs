// Cartero F1 core — proves the SPEC-F0 contract in memory (no git, no network).
// Run: node test/cartero.test.mjs
import { createIdentity, publicIdentityDoc, buildEvent, eventPath } from "../vendor/postal/src/postal.js";
import { buildUri, parseUri } from "../src/uri.js";
import { deriveChatId, buildDm, openDm, verifyDm, resolveConversation } from "../src/convo.js";
import { encryptFile, decryptFile, makeDescriptor } from "../src/attach.js";

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log("  ok  -", n)) : (fail++, console.error("  FAIL-", n)); };

// Two parties (+ an outsider). Directory maps id -> public identity doc.
const alice = await createIdentity("Alice");
const bob = await createIdentity("Bob");
const mallory = await createIdentity("Mallory");
const directory = Object.fromEntries(await Promise.all(
  [alice, bob, mallory].map(async (i) => [i.id, await publicIdentityDoc(i)])));

const T = (i) => `2026-06-17T20:${String(i).padStart(2, "0")}:00.000Z`;
const item = (ev) => ({ path: eventPath(ev.chat_id, ev), event: ev });

console.log("# URI build/parse");
const uri = buildUri({ host: "github.com", owner: "alice", repo: "cartero-outbox", id: alice.id });
ok("builds postal:// URI", uri === `postal://github.com/alice/cartero-outbox#${alice.id}`);
const p = parseUri(uri);
ok("parses it back", p.host === "github.com" && p.owner === "alice" && p.repo === "cartero-outbox" && p.id === alice.id);
ok("rejects a non-postal string", (() => { try { parseUri("https://x/y#z"); return false; } catch { return true; } })());

console.log("# chat_id derivation");
const cid = await deriveChatId(alice.id, bob.id);
ok("derivation is symmetric", cid === await deriveChatId(bob.id, alice.id));
ok("looks like dm_<32hex>", /^dm_[0-9a-f]{32}$/.test(cid));
ok("differs for a different pair", cid !== await deriveChatId(alice.id, mallory.id));

console.log("# sealed DM round-trip (both parties read; outsider can't)");
const ev = await buildDm(alice, bob.id, { text: "hola bob 👋", reply_to: null, attachments: [] },
  { created_at: T(1), rnd: "m1", seq: 0, prev: null, directory });
ok("event is a sealed dm", ev.kind === "dm" && /^POSTAL1:/.test(ev.body.sealed) && !JSON.stringify(ev.body).includes("hola bob"));
ok("recipient (bob) reads it", (await openDm(ev, bob)).text === "hola bob 👋");
ok("sender (alice) reads her own sent", (await openDm(ev, alice)).text === "hola bob 👋");
ok("outsider (mallory) CANNOT open it", await (async () => { try { await openDm(ev, mallory); return false; } catch { return true; } })());

console.log("# the gate");
ok("valid dm passes", (await verifyDm(ev, { directory })).ok);
const tampered = { ...ev, sig: ev.sig.slice(0, -4) + (ev.sig.endsWith("AAAA") ? "BBBB" : "AAAA") };
ok("tampered signature rejected", (await verifyDm(tampered, { directory })).reasons.includes("invalid-signature"));
const wrongChat = await buildEvent(alice, { kind: "dm", chat_id: "dm_" + "0".repeat(32), to: [bob.id], created_at: T(2), rnd: "w", body: { x: 1 }, seq: 0, prev: null });
ok("wrong chat_id rejected (sig still valid)", (await verifyDm(wrongChat, { directory })).reasons.includes("chat-id-mismatch"));
const selfDm = await buildEvent(alice, { kind: "dm", chat_id: await deriveChatId(alice.id, alice.id), to: [alice.id], created_at: T(3), rnd: "s", body: {}, seq: 0, prev: null });
ok("self-dm rejected", (await verifyDm(selfDm, { directory })).reasons.includes("self-dm"));
ok("unknown author rejected (not in directory)", (await verifyDm(ev, { directory: {} })).reasons.includes("unknown-author"));

console.log("# attachments: encrypt -> hash-address -> verify -> decrypt");
const fileBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 1, 2, 3, 250, 99]); // pretend a small file
const { ct, hash, key } = await encryptFile(fileBytes);
ok("ciphertext does not contain the plaintext tail", !Array.from(ct).join(",").includes("250,99"));
const back = await decryptFile(ct, key, hash);
ok("decrypts to the original bytes", back.length === fileBytes.length && back.every((b, i) => b === fileBytes[i]));
const swapped = ct.slice(); swapped[swapped.length - 1] ^= 0xff;
ok("a tampered/swapped blob is caught by the hash", await (async () => { try { await decryptFile(swapped, key, hash); return false; } catch { return true; } })());

console.log("# attachment descriptor travels sealed inside a dm");
const desc = makeDescriptor({ name: "doc.pdf", mime: "application/pdf", size: fileBytes.length, hash, key });
const evA = await buildDm(alice, bob.id, { text: "te paso el doc", reply_to: null, attachments: [desc] },
  { created_at: T(4), rnd: "m2", seq: 1, prev: null, directory });
ok("descriptor is not visible in the ciphertext", !JSON.stringify(evA.body).includes("doc.pdf"));
const openedA = await openDm(evA, bob);
ok("recipient recovers the descriptor + can decrypt the blob",
  openedA.attachments[0].name === "doc.pdf" &&
  (await decryptFile(ct, openedA.attachments[0].key, openedA.attachments[0].hash)).length === fileBytes.length);

console.log("# conversation = merge of TWO outboxes, causal order");
// alice's outbox: m1 (T1), m2 (T4). bob's outbox: one reply (T2).
const bobReply = await buildDm(bob, alice.id, { text: "hola alice!", reply_to: ev.id, attachments: [] },
  { created_at: T(2), rnd: "r1", seq: 0, prev: null, directory });
const merged = [item(ev), item(evA), item(bobReply)];           // both repos' events, unordered
const convoForBob = await resolveConversation(merged, bob, { directory });
ok("all three messages resolve", convoForBob.length === 3 && convoForBob.every((m) => m.readable));
ok("ordered by time (m1, reply, m2)", convoForBob.map((m) => m.at).join() === [T(1), T(2), T(4)].join());
ok("attribution is correct", convoForBob[0].from === alice.id && convoForBob[1].from === bob.id && convoForBob[1].mine);
ok("reply threads to the first message", convoForBob[1].reply_to === ev.id);

console.log("# append-only: a duplicated path is dropped on merge");
const dup = await resolveConversation([item(ev), item(ev)], bob, { directory });
ok("the same event twice yields one message", dup.length === 1);

console.log("# a forged event in the stream never reaches the conversation");
const forged = { ...ev, sig: ev.sig.slice(0, -2) + "zz" };
const withForged = await resolveConversation([item(ev), item(forged)], bob, { directory });
ok("forged duplicate is dropped, only the real one stays", withForged.length === 1);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
