// Cartero — bot runtime. A bot is just an identity (a key) with an outbox (a repo), same as a
// human (DESIGN-bots.md §1). This module recomposes the primitives already used by the CLI —
// watch (poll), the two-outbox merge (inbox/read), and send — into a handler loop with a
// PERSISTENT cursor so a restart never re-answers a message it already answered.
//
// Delivery is at-least-once, NOT exactly-once: with git as transport there is no exactly-once.
// Handlers must tolerate reprocessing. The cursor records processed event ids per chat; we
// persist it AFTER reply() confirms the commit, so a crash between handler and commit retries
// (reprocesses at most one) rather than dropping a message (DESIGN-bots.md §6).
//
// Dependency-injected so the same code runs against real GitHub (CLI/examples) and in memory
// (test/bot.test.mjs): pass selfOutbox / peerOutbox / contacts / cursorStore to override the
// real-I/O defaults. outbox() already accepts an injected client, which is the test seam.

import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { publicIdentityDoc, eventHash } from "../vendor/postal/src/postal.js";
import { outbox, eventPath } from "./outbox.js";
import { buildDm, deriveChatId, resolveConversation } from "./convo.js";
import { parseUri } from "./uri.js";
import { publish as relayPublish } from "./relay.js";
import * as state from "./state.js";

// --- pure core (no I/O — unit-testable) ------------------------------------------------------
// From a resolved conversation (resolveConversation output) pick the messages this bot should
// act on: INBOUND (not its own) and not already processed. Order is preserved (causal).
export function freshInbound(convo, { myId, processed }) {
  return convo.filter((m) => m.from !== myId && !processed.has(m.id));
}

// Next (seq, prev) for my chain in this chat, read fresh from my outbox (same rule as the CLI).
async function chainOf(out, chat, myId) {
  const mine = (await out.readChat(chat)).filter((it) => it.event.from === myId).sort((a, b) => a.event.seq - b.event.seq);
  return { seq: mine.length, prev: mine.length ? await eventHash(mine[mine.length - 1].event) : null };
}

// Default cursor store: <CARTERO_HOME>/cursor.json  →  { "<chat_id>": ["<id>", ...] }
function fsCursorStore(dir = state.stateDir) {
  const file = join(dir, "cursor.json");
  return {
    async load() { try { return JSON.parse(await readFile(file, "utf8")); } catch { return {}; } },
    async save(obj) { await mkdir(dir, { recursive: true }); await writeFile(file, JSON.stringify(obj, null, 2)); },
  };
}

export async function createBot(opts = {}) {
  const {
    pass, token, relay,
    identity = await state.loadIdentity(pass),
    cfg = await state.loadConfig(),
    // I/O seams (overridable for tests):
    selfOutbox = outbox({ host: cfg.host, owner: cfg.owner, repo: cfg.repo, token }),
    peerOutbox = (uri) => { const u = parseUri(uri); return outbox({ host: u.host, owner: u.owner, repo: u.repo, token }); },
    contacts = null,                          // null → read state.loadContacts() each tick (live)
    cursorStore = fsCursorStore(),
    onError = (e) => console.error("✗ " + (e && e.message ? e.message : e)),
  } = opts;
  if (!cfg) throw new Error("no outbox config — run `cartero init` first");

  const handlers = [];
  const commands = new Map();                  // "/name" -> handler
  const raw = await cursorStore.load();         // { chat: [ids] }
  const processed = new Map(Object.entries(raw).map(([c, ids]) => [c, new Set(ids)]));
  const seenOf = (chat) => { let s = processed.get(chat); if (!s) processed.set(chat, (s = new Set())); return s; };
  const persist = () => cursorStore.save(Object.fromEntries([...processed].map(([c, s]) => [c, [...s]])));

  let timer = null;
  const bot = {
    id: identity.id,
    onMessage(fn) { handlers.push(fn); return bot; },
    command(name, fn) { commands.set(name.startsWith("/") ? name : "/" + name, fn); return bot; },

    // Process one contact's conversation: merge both outboxes, dispatch fresh inbound messages.
    async tickContact(name, contact) {
      const peerO = peerOutbox(contact.uri);
      const peerDoc = await peerO.readIdentity(contact.id);
      if (!peerDoc) return;                                  // peer outbox unreachable/unverifiable
      peerDoc.devices = await peerO.readDevices();
      const myDoc = await publicIdentityDoc(identity); myDoc.devices = await selfOutbox.readDevices();
      const directory = { [identity.id]: myDoc, [peerDoc.id]: peerDoc };
      const chat = await deriveChatId(identity.id, peerDoc.id);
      const items = [...await selfOutbox.readChat(chat), ...await peerO.readChat(chat)];
      const convo = await resolveConversation(items, identity, { directory });
      const seen = seenOf(chat);

      for (const msg of freshInbound(convo, { myId: identity.id, processed: seen })) {
        const ctx = {
          identity, directory, chat, contact: name, msg,
          // reply seals to the peer, threads on this message (reply_to), commits to MY outbox.
          async reply(text, { file } = {}) {
            if (file) throw new Error("attachment replies not implemented in the minimal runtime");
            const c = await chainOf(selfOutbox, chat, identity.id);
            const created_at = new Date().toISOString();
            const rnd = Math.random().toString(36).slice(2, 8);
            const ev = await buildDm(identity, peerDoc.id, { text, reply_to: msg.id, attachments: [] },
              { created_at, rnd, seq: c.seq, prev: c.prev, directory });
            await selfOutbox.appendEvent({ path: eventPath(chat, ev), event: ev });
            if (relay) await relayPublish(relay, chat, ev);
            return ev.id;
          },
        };
        // command routing: first whitespace-delimited token, if it matches a registered command.
        const cmd = msg.readable && msg.text ? commands.get(msg.text.trim().split(/\s+/)[0]) : null;
        if (cmd) await cmd(msg, ctx);
        else for (const h of handlers) await h(msg, ctx);
        seen.add(msg.id);                                    // mark AFTER handlers/reply resolved
        await persist();                                     // at-least-once: persist post-commit
      }
    },

    async tick() {
      const list = contacts || await state.loadContacts();
      for (const [name, c] of Object.entries(list)) {
        try { await bot.tickContact(name, c); } catch (e) { onError(e); }
      }
    },

    async start({ intervalMs = 3000, once = false } = {}) {
      await bot.tick();
      if (once) return bot;
      timer = setInterval(() => bot.tick().catch(onError), intervalMs);
      return bot;
    },
    stop() { if (timer) { clearInterval(timer); timer = null; } },
  };
  return bot;
}
