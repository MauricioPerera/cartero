#!/usr/bin/env node
// Cartero CLI — sovereign 1:1 E2EE messaging over git (MVP). Commands:
//   cartero init <owner/repo> [--host H] [--name N]   create identity + outbox, print your URI
//   cartero contact add <uri> [petname]               resolve+verify a contact, save a petname
//   cartero send <petname> <text...> [--file path]    send a sealed DM (optional attachment)
//   cartero read <petname> [--save dir]               print the conversation (merge both outboxes)
//   cartero watch <petname>                            poll and print new messages
//
// Secrets: passphrase via $CARTERO_PASS; GitHub token via $GH_TOKEN. Identity is stored
// encrypted under ~/.cartero (override with $CARTERO_HOME).
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { createIdentity, publicIdentityDoc, eventHash } from "../vendor/postal/src/postal.js";
import { outbox, eventPath } from "./outbox.js";
import { buildDm, deriveChatId, resolveConversation, verifyDm, openDm } from "./convo.js";
import { publish as relayPublish, subscribe as relaySubscribe } from "./relay.js";
import { encryptFile, decryptFile, makeDescriptor } from "./attach.js";
import { parseUri } from "./uri.js";
import { resolveHandle, buildHandleDoc, parseHandle } from "./handle.js";
import * as state from "./state.js";

const die = (m) => { console.error("✗ " + m); process.exit(1); };
const pass = () => process.env.CARTERO_PASS || die("set CARTERO_PASS (your identity passphrase)");
const token = () => process.env.GH_TOKEN || die("set GH_TOKEN (a GitHub token with repo access)");
const flag = (args, name) => { const i = args.indexOf("--" + name); return i >= 0 ? args[i + 1] : null; };
const positional = (args) => args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")));

// Default relay (the deployed public one). Override with --relay <url>, disable with --no-relay.
const DEFAULT_RELAY = process.env.CARTERO_RELAY || "https://cartero.ardf.dev";
const relayUrl = (args) => args.includes("--no-relay") ? null : (flag(args, "relay") || DEFAULT_RELAY);

const myOutbox = (cfg) => outbox({ host: cfg.host, owner: cfg.owner, repo: cfg.repo, token: token() });
const peerOutbox = (uri) => { const u = parseUri(uri); return outbox({ host: u.host, owner: u.owner, repo: u.repo, token: token() }); };

// Next (seq, prev) for my chain in this chat, read fresh from my outbox.
async function chainOf(out, chat, myId) {
  const mine = (await out.readChat(chat)).filter((it) => it.event.from === myId).sort((a, b) => a.event.seq - b.event.seq);
  return { seq: mine.length, prev: mine.length ? await eventHash(mine[mine.length - 1].event) : null };
}

// Load identity + config + the peer's verified doc; returns everything send/read need.
async function context(petname) {
  const identity = await state.loadIdentity(pass());
  const cfg = await state.loadConfig() || die("no outbox config — run `cartero init`");
  const contact = await state.resolveContact(petname);
  const peerDoc = await peerOutbox(contact.uri).readIdentity(contact.id) || die("cannot resolve peer identity from their outbox");
  const directory = { [identity.id]: await publicIdentityDoc(identity), [peerDoc.id]: peerDoc };
  return { identity, cfg, contact, peerDoc, directory, chat: await deriveChatId(identity.id, peerDoc.id) };
}

async function cmdInit(args) {
  const [slug] = positional(args.slice(1));
  if (!slug || !slug.includes("/")) die("usage: cartero init <owner/repo> [--host H] [--name N]");
  const [owner, repo] = slug.split("/");
  const host = flag(args, "host") || "github.com";
  if (await state.hasIdentity()) die("an identity already exists in " + state.stateDir + " (refusing to overwrite)");
  const identity = await createIdentity(flag(args, "name") || "");
  await state.saveIdentity(identity, pass());
  await state.saveConfig({ host, owner, repo });
  const out = myOutbox({ host, owner, repo });
  await out.publishIdentity(await publicIdentityDoc(identity));
  console.log("✓ identity created and published");
  console.log("  id:   " + identity.id);
  console.log("  share this URI:\n  " + out.uri(identity.id));

  const handle = flag(args, "handle");                 // optional human-readable address
  if (handle) {
    const { user, domain } = parseHandle(handle);
    const hdoc = await buildHandleDoc(identity, { handle, outbox: out.uri(identity.id).split("#")[0] });
    const wk = flag(args, "well-known");
    if (wk) { await writeFile(wk, JSON.stringify(hdoc, null, 2)); console.log(`  wrote ${wk}`); }
    else { console.log(`\n  publish this at https://${domain}/.well-known/postal/${user}.json :\n`); console.log(JSON.stringify(hdoc, null, 2)); }
    console.log(`\n  then others reach you as: ${handle}`);
  }
}

async function cmdContactAdd(args) {
  const pos = positional(args.slice(2));
  let target = pos[0], petname = pos[1];
  if (!target) die("usage: cartero contact add <user@domain | uri> [petname]");
  let uri, handle = null;
  if (target.startsWith("postal://")) {
    uri = target;
  } else {                                              // a user@domain handle -> resolve via .well-known
    const r = await resolveHandle(target);
    uri = `${r.outbox}#${r.id}`;
    handle = r.handle;
    if (!petname) petname = parseHandle(target).user;
  }
  const u = parseUri(uri);
  const doc = await peerOutbox(uri).readIdentity(u.id) || die("could not resolve/verify an identity at that outbox");
  if (doc.id !== u.id) die("fingerprint does not match the published identity");
  const name = petname || ("anon-" + u.id.slice(0, 6));
  await state.saveContact(name, { id: doc.id, uri, handle, verified: true, verified_at: new Date().toISOString() });
  console.log(`✓ saved contact "${name}"` + (handle ? ` (${handle})` : ""));
  console.log("  VERIFY out-of-band that this fingerprint is really theirs:\n  " + doc.id);
}

async function cmdSend(args) {
  const [petname, ...rest] = positional(args.slice(1));
  const text = rest.join(" ");
  const file = flag(args, "file");
  if (!petname || (!text && !file)) die("usage: cartero send <petname> <text> [--file path]");
  const { identity, cfg, directory, chat } = await context(petname);
  const out = myOutbox(cfg);
  const peerId = Object.keys(directory).find((id) => id !== identity.id);

  const attachments = [], blobFiles = [];
  if (file) {
    const bytes = new Uint8Array(await readFile(file));
    const enc = await encryptFile(bytes);
    attachments.push(makeDescriptor({ name: basename(file), mime: "application/octet-stream", size: bytes.length, hash: enc.hash, key: enc.key }));
    blobFiles.push(out.blobFile(enc.hash, enc.ct));
  }
  const c = await chainOf(out, chat, identity.id);
  const created_at = new Date().toISOString();
  const rnd = Math.random().toString(36).slice(2, 8);
  const ev = await buildDm(identity, peerId, { text, reply_to: null, attachments }, { created_at, rnd, seq: c.seq, prev: c.prev, directory });
  await out.appendEvent({ path: eventPath(chat, ev), event: ev }, blobFiles);
  const relay = relayUrl(args);                           // instant fan-out by default (git stays the record)
  if (relay) await relayPublish(relay, chat, ev);
  console.log("✓ sent" + (file ? " (+1 attachment)" : "") + (relay ? " (relayed)" : ""));
}

async function loadConvo(petname) {
  const { identity, cfg, contact, directory, chat } = await context(petname);
  const mine = myOutbox(cfg), theirs = peerOutbox(contact.uri);
  const merged = [...await mine.readChat(chat), ...await theirs.readChat(chat)];
  return { convo: await resolveConversation(merged, identity, { directory }), theirs, contact };
}

function printConvo(convo, contact) {
  for (const m of convo) {
    const who = m.mine ? "you" : contact;
    const body = m.readable ? m.text + m.attachments.map((a) => ` [📎 ${a.name}]`).join("") : "🔒(not for you)";
    console.log(`${m.at.slice(11, 16)}  ${who.padEnd(10)}  ${body}`);
  }
}

async function cmdRead(args) {
  const [petname] = positional(args.slice(1));
  if (!petname) die("usage: cartero read <petname> [--save dir]");
  const { convo, theirs, contact } = await loadConvo(petname);
  printConvo(convo, petname);
  const saveDir = flag(args, "save");
  if (saveDir) {
    await mkdir(saveDir, { recursive: true });
    for (const m of convo) for (const a of m.attachments) {
      try {
        const ct = await theirs.getBlob(a.locator) || (await myOutbox(await state.loadConfig()).getBlob(a.locator));
        if (ct) { await writeFile(join(saveDir, a.name), await decryptFile(ct, a.key, a.hash)); console.log("  saved " + a.name); }
      } catch (e) { console.error("  ✗ " + a.name + ": " + e.message); }
    }
  }
}

async function cmdWatch(args) {
  const [petname] = positional(args.slice(1));
  if (!petname) die("usage: cartero watch <petname> [--relay url]");
  const seen = new Set();
  const tick = async () => {
    const { convo } = await loadConvo(petname);
    for (const m of convo) if (!seen.has(m.id)) { seen.add(m.id); printConvo([m], petname); }
  };
  await tick();
  setInterval(() => tick().catch((e) => console.error("✗ " + e.message)), 3000);   // poll = backfill + durable record

  const relay = relayUrl(args);
  if (relay) {                                            // + instant delivery; gate every relayed event
    const { identity, directory, chat } = await context(petname);
    relaySubscribe(relay, chat, async (ev) => {
      if (seen.has(ev.id) || !(await verifyDm(ev, { directory })).ok) return;
      seen.add(ev.id);
      let c = null; try { c = await openDm(ev, identity); } catch {}
      printConvo([{ id: ev.id, from: ev.from, at: ev.created_at, mine: ev.from === identity.id,
        text: c ? c.text : null, reply_to: c ? c.reply_to || null : null, attachments: c ? c.attachments || [] : [], readable: !!c }], petname);
    }).catch((e) => console.error("relay: " + e.message));
  }
}

const [cmd, sub] = process.argv.slice(2);
const args = process.argv.slice(2);
try {
  if (cmd === "init") await cmdInit(args);
  else if (cmd === "contact" && sub === "add") await cmdContactAdd(args);
  else if (cmd === "send") await cmdSend(args);
  else if (cmd === "read") await cmdRead(args);
  else if (cmd === "watch") await cmdWatch(args);
  else die("commands: init · contact add · send · read · watch");
} catch (e) { die(e.message); }
