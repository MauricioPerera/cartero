// Cartero bot runtime — proves the agent-as-peer loop end-to-end IN MEMORY (no git, no network).
// Two identities (human "alice" + bot "echo"), each with its own outbox backed by an in-memory
// client (the same `outbox({ client })` seam the real GitHub transport plugs into). We drive the
// full 6-stage cycle from DESIGN-bots.md §5: alice sends -> bot ticks -> handler -> reply ->
// cursor persists -> alice reads the reply. Run: node test/bot.test.mjs

import { createIdentity, publicIdentityDoc, eventHash } from "../vendor/postal/src/postal.js";
import { outbox, eventPath } from "../src/outbox.js";
import { buildDm, deriveChatId, resolveConversation } from "../src/convo.js";
import { createBot, freshInbound } from "../src/bot.js";

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log("  ok  -", n)) : (fail++, console.error("  FAIL-", n)); };

// In-memory git host: a Map<path, content> implementing the 4 methods outbox() calls on a client.
const memHost = () => {
  const store = new Map();
  return {
    store,
    client: {
      async putFile(path, content) { store.set(path, content); },
      async getFile(path) { return store.has(path) ? { content: store.get(path) } : null; },
      async commitFiles(files) { for (const f of files) store.set(f.path, f.content); },
      async listTree(prefix) { return [...store.keys()].filter((k) => k.indexOf(prefix) === 0); },
    },
  };
};

// Two identities, two outboxes (two repos).
const alice = await createIdentity("Alice");
const echo = await createIdentity("Echo");
const aliceHost = memHost(), echoHost = memHost();
const aliceUri = `postal://github.com/alice/inbox#${alice.id}`;
const echoUri = `postal://github.com/echo/inbox#${echo.id}`;
const aliceOut = outbox({ host: "github.com", owner: "alice", repo: "inbox", client: aliceHost.client });
const echoOut = outbox({ host: "github.com", owner: "echo", repo: "inbox", client: echoHost.client });
await aliceOut.publishIdentity(await publicIdentityDoc(alice));
await echoOut.publishIdentity(await publicIdentityDoc(echo));

// Directory + chat as the two sides compute them independently.
const directory = { [alice.id]: await publicIdentityDoc(alice), [echo.id]: await publicIdentityDoc(echo) };
const chat = await deriveChatId(alice.id, echo.id);

// alice -> echo, written to ALICE's outbox (each party writes only its own). seq/prev are read
// from her own chain (same rule as the CLI's chainOf), independent of the timestamp index `i`.
async function aliceSends(text, i) {
  const mine = (await aliceOut.readChat(chat)).filter((it) => it.event.from === alice.id).sort((a, b) => a.event.seq - b.event.seq);
  const seq = mine.length, prev = mine.length ? await eventHash(mine[mine.length - 1].event) : null;
  const ev = await buildDm(alice, echo.id, { text, reply_to: null, attachments: [] },
    { created_at: `2026-06-18T10:${String(i).padStart(2, "0")}:00.000Z`, rnd: "a" + i, seq, prev, directory });
  await aliceOut.appendEvent({ path: eventPath(chat, ev), event: ev });
  return ev.id;
}
// What alice sees when she reads (merge of both outboxes).
const aliceView = async () => resolveConversation(
  [...await aliceOut.readChat(chat), ...await echoOut.readChat(chat)], alice, { directory });

// --- the bot, wired to the in-memory outboxes; cursor in a plain object store -----------------
let cursorObj = {};
const cursorStore = { async load() { return cursorObj; }, async save(o) { cursorObj = o; } };
const makeBot = async () => {
  const b = await createBot({
    identity: echo, cfg: { host: "github.com", owner: "echo", repo: "inbox" },
    selfOutbox: echoOut,
    peerOutbox: (uri) => (uri === aliceUri ? aliceOut : null),
    contacts: { alice: { id: alice.id, uri: aliceUri } },
    cursorStore,
  });
  b.onMessage(async (msg, ctx) => { if (msg.readable) await ctx.reply("echo: " + msg.text); });
  return b;
};

console.log("# pure core: freshInbound selects inbound, unprocessed, in order");
{
  const convo = [{ id: "x", from: alice.id }, { id: "y", from: echo.id }, { id: "z", from: alice.id }];
  const sel = freshInbound(convo, { myId: echo.id, processed: new Set(["x"]) });
  ok("skips my own + already-processed; keeps the rest", sel.length === 1 && sel[0].id === "z");
}

console.log("# end-to-end: alice sends -> bot echoes -> alice sees the reply");
await aliceSends("hola", 1);
let bot = await makeBot();
await bot.start({ once: true });
let view = await aliceView();
ok("conversation now has 2 messages (sent + echo)", view.length === 2);
ok("the reply is the echo, readable by alice", view[1].readable && view[1].text === "echo: hola");
ok("the echo is from the bot, threaded on alice's message", view[1].from === echo.id && view[1].reply_to === view[0].id);
ok("cursor recorded the processed message", (cursorObj[chat] || []).length === 1);

console.log("# idempotency: a second tick does NOT re-answer (persistent cursor)");
await bot.start({ once: true });
ok("still exactly one echo (no duplicate reply)", (await aliceView()).filter((m) => m.from === echo.id).length === 1);

console.log("# restart: a fresh bot loads the cursor and still does not re-answer");
bot = await makeBot();                                   // new instance, same cursorStore
await bot.start({ once: true });
ok("after restart, still one echo", (await aliceView()).filter((m) => m.from === echo.id).length === 1);

console.log("# a new inbound message after restart IS answered");
await aliceSends("otra", 2);
await bot.start({ once: true });
view = await aliceView();
ok("now two echoes, second threads on the second message",
  view.filter((m) => m.from === echo.id).length === 2 &&
  view.find((m) => m.text === "echo: otra")?.reply_to === view.find((m) => m.text === "otra")?.id);

console.log("# commands: /ping is routed to the command handler, not onMessage");
let echoedPing = false;
const cmdBot = await createBot({
  identity: echo, cfg: { host: "github.com", owner: "echo", repo: "inbox" },
  selfOutbox: echoOut, peerOutbox: (uri) => (uri === aliceUri ? aliceOut : null),
  contacts: { alice: { id: alice.id, uri: aliceUri } },
  cursorStore: { async load() { return cursorObj; }, async save(o) { cursorObj = o; } },
});
cmdBot.command("/ping", async (_m, ctx) => { await ctx.reply("pong"); });
cmdBot.onMessage(async (m) => { if (m.text === "/ping") echoedPing = true; });
await aliceSends("/ping", 3);
await cmdBot.start({ once: true });
view = await aliceView();
ok("/ping produced a pong reply", view.some((m) => m.text === "pong"));
ok("/ping did NOT fall through to onMessage", echoedPing === false);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
