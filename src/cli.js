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
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { createIdentity, publicIdentityDoc, eventHash } from "../vendor/postal/src/postal.js";
import { outbox, eventPath } from "./outbox.js";
import { buildDm, deriveChatId, resolveConversation, verifyDm, openDm } from "./convo.js";
import { buildGroupDoc, verifyGroupDoc, buildGm, resolveGroup as resolveGroupItems } from "./group.js";
import { buildDeviceCert } from "./device.js";
import { buildRegistryRecord, publishToRegistry, resolveId } from "./registry.js";
import { summarizeInbox, preview } from "./inbox.js";
import { publish as relayPublish, subscribe as relaySubscribe } from "./relay.js";
import { encryptFile, decryptFile, makeDescriptor, mimeFor, DEFAULT_MAX_ATTACH } from "./attach.js";
import { parseUri } from "./uri.js";
import { resolveHandle, buildHandleDoc, parseHandle } from "./handle.js";
import * as state from "./state.js";

const die = (m) => { console.error("✗ " + m); process.exit(1); };
const pass = () => process.env.CARTERO_PASS || die("set CARTERO_PASS (your identity passphrase)");
const token = () => process.env.GH_TOKEN || die("set GH_TOKEN (a GitHub token with repo access)");
const flag = (args, name) => { const i = args.indexOf("--" + name); return i >= 0 ? args[i + 1] : null; };
const positional = (args) => args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")));

// Relay is OPT-IN / self-hosted by default: no third-party relay unless you point at one with
// --relay <url> or $CARTERO_RELAY. With none set, delivery is git-only (async). --no-relay forces off.
const relayUrl = (args) => args.includes("--no-relay") ? null : (flag(args, "relay") || process.env.CARTERO_RELAY || null);
// Discovery registry (id -> outbox): opt-in / self-hosted, like the relay.
const registryUrl = (args) => flag(args, "registry") || process.env.CARTERO_REGISTRY || null;
const maxAttach = (args) => Math.round((Number(flag(args, "max-mb")) || Number(process.env.CARTERO_MAX_ATTACH_MB) || (DEFAULT_MAX_ATTACH / 1048576)) * 1048576);

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
  const peerO = peerOutbox(contact.uri);
  const peerDoc = await peerO.readIdentity(contact.id) || die("cannot resolve peer identity from their outbox");
  peerDoc.devices = await peerO.readDevices();                       // multi-device: peer's certified devices
  const myDoc = await publicIdentityDoc(identity); myDoc.devices = await myOutbox(cfg).readDevices();
  const directory = { [identity.id]: myDoc, [peerDoc.id]: peerDoc };
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
  const bareId = target.replace(/^postal:/, "");
  if (target.startsWith("postal://")) {
    uri = target;
  } else if (/^[A-Fa-f0-9]{16}$/.test(bareId)) {        // a bare id -> resolve outbox via the registry
    const reg = registryUrl(args) || die("resolving a bare id needs a registry: --registry <url> or $CARTERO_REGISTRY");
    const r = await resolveId(reg, bareId);
    uri = `${r.outbox}#${r.id}`;
    if (!petname) petname = bareId.slice(0, 6);
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
  if (file) { const a = await attachOne(file, out, maxAttach(args)); attachments.push(a.desc); blobFiles.push(a.blob); }
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

// --- groups (F3) -----------------------------------------------------------
const outboxFromUri = (uri, id) => { const u = parseUri(uri.includes("#") ? uri : `${uri}#${id}`); return outbox({ host: u.host, owner: u.owner, repo: u.repo, token: token() }); };

// Build the directory (id -> verified identity doc) by reading each member's outbox via the roster.
async function groupDirectory(doc) {
  const dir = {};
  for (const [id, ob] of Object.entries(doc.roster || {})) {
    const o = outboxFromUri(ob, id);
    const d = await o.readIdentity(id);
    if (d) { d.devices = await o.readDevices(); dir[id] = d; }       // multi-device: each member's certs
  }
  return dir;
}
const nameOf = (directory, id, myId) => id === myId ? "you" : ((directory[id] && directory[id].display_name) || id.slice(0, 8));

// Encrypt a file into an attachment descriptor + blob (shared by DM and group send). Refuses files
// over `maxBytes` (blobs go straight to git, so an unbounded file would bloat the repo).
async function attachOne(file, out, maxBytes = DEFAULT_MAX_ATTACH) {
  const { size } = await stat(file);
  if (size > maxBytes) die(`attachment too large: ${(size / 1048576).toFixed(1)} MB > ${(maxBytes / 1048576).toFixed(0)} MB limit (raise with --max-mb or $CARTERO_MAX_ATTACH_MB)`);
  const bytes = new Uint8Array(await readFile(file));
  const enc = await encryptFile(bytes);
  return { desc: makeDescriptor({ name: basename(file), mime: mimeFor(file), size: bytes.length, hash: enc.hash, key: enc.key }), blob: out.blobFile(enc.hash, enc.ct) };
}

async function groupCreate(args) {
  const pos = positional(args.slice(2));                  // [name, petname...]
  const name = pos[0], petnames = pos.slice(1);
  if (!name || !petnames.length) die("usage: cartero group create <name> <petname...>");
  const identity = await state.loadIdentity(pass());
  const cfg = await state.loadConfig() || die("run `cartero init` first");
  const myUri = `postal://${cfg.host}/${cfg.owner}/${cfg.repo}`;
  const roster = { [identity.id]: myUri }, members = [identity.id];
  for (const pn of petnames) { const c = await state.resolveContact(pn); const u = parseUri(c.uri); roster[c.id] = `postal://${u.host}/${u.owner}/${u.repo}`; members.push(c.id); }
  const doc = await buildGroupDoc(identity, { name, members, roster, created_at: new Date().toISOString(), rnd: Math.random().toString(36).slice(2, 8) });
  await myOutbox(cfg).publishGroup(doc);
  await state.saveGroup(name, doc);
  console.log(`✓ group "${name}" created: ${doc.id} (${members.length} members)`);
  console.log(`  members join with:\n  cartero group join ${myUri}#${identity.id} ${doc.id}`);
}

async function groupJoin(args) {
  const [creatorUri, groupId, localname] = positional(args.slice(2));
  if (!creatorUri || !groupId) die("usage: cartero group join <creator-outbox-uri> <group-id> [localname]");
  const doc = await outboxFromUri(creatorUri, parseUri(creatorUri).id).readGroup(groupId) || die("group doc not found in that outbox");
  if (!(await verifyGroupDoc(doc, { directory: await groupDirectory(doc) }))) die("group doc failed verification");
  const name = localname || doc.name || groupId.slice(0, 12);
  await state.saveGroup(name, doc);
  console.log(`✓ joined group "${name}" (${doc.id}), ${doc.members.length} members`);
}

async function groupSend(args) {
  const pos = positional(args.slice(2));
  const name = pos[0], text = pos.slice(1).join(" "), file = flag(args, "file");
  if (!name || (!text && !file)) die("usage: cartero group send <name> <text> [--file path]");
  const identity = await state.loadIdentity(pass());
  const cfg = await state.loadConfig() || die("run `cartero init` first");
  const doc = await state.resolveGroup(name);
  const directory = await groupDirectory(doc);
  directory[identity.id] = await publicIdentityDoc(identity);
  const out = myOutbox(cfg);
  const attachments = [], blobFiles = [];
  if (file) { const a = await attachOne(file, out, maxAttach(args)); attachments.push(a.desc); blobFiles.push(a.blob); }
  const c = await chainOf(out, doc.id, identity.id);
  const ev = await buildGm(identity, doc, { text, reply_to: null, attachments }, { created_at: new Date().toISOString(), rnd: Math.random().toString(36).slice(2, 8), seq: c.seq, prev: c.prev, directory });
  await out.appendEvent({ path: eventPath(doc.id, ev), event: ev }, blobFiles);
  const relay = relayUrl(args); if (relay) await relayPublish(relay, doc.id, ev);
  console.log("✓ sent to group" + (file ? " (+1 attachment)" : "") + (relay ? " (relayed)" : ""));
}

async function groupRead(args) {
  const [name] = positional(args.slice(2));
  if (!name) die("usage: cartero group read <name>");
  const identity = await state.loadIdentity(pass());
  const doc = await state.resolveGroup(name);
  const directory = await groupDirectory(doc);
  const merged = [];
  for (const [id, ob] of Object.entries(doc.roster || {})) merged.push(...await outboxFromUri(ob, id).readChat(doc.id));
  const convo = await resolveGroupItems(merged, identity, { groupDoc: doc, directory });
  for (const m of convo) {
    const who = nameOf(directory, m.from, identity.id);
    const body = m.readable ? m.text + m.attachments.map((a) => ` [📎 ${a.name}]`).join("") : "🔒(not for you)";
    console.log(`${m.at.slice(11, 16)}  ${who.padEnd(10)}  ${body}`);
  }
}

async function cmdGroup(args) {
  const sub = args[1];
  if (sub === "create") return groupCreate(args);
  if (sub === "join") return groupJoin(args);
  if (sub === "send") return groupSend(args);
  if (sub === "read") return groupRead(args);
  die("usage: cartero group <create|join|send|read> ...");
}

// --- multi-device (F3) -----------------------------------------------------
async function deviceAdd(args) {
  const [name] = positional(args.slice(2));
  const identity = await state.loadIdentity(pass());      // the master (this device holds the master key)
  const cfg = await state.loadConfig() || die("run `cartero init` first");
  const device = await createIdentity(identity.display_name || "");   // a fresh keypair for the new device
  const cert = await buildDeviceCert(identity, device, { name: name || "device", created_at: new Date().toISOString() });
  const out = myOutbox(cfg);
  await out.publishDevices([...(await out.readDevices()), cert]);      // publish so peers seal to it + accept it
  // The new device acts AS the identity: same id + display name, but the device's OWN keys.
  const bundle = { identity: { id: identity.id, display_name: identity.display_name, sign: device.sign, enc: device.enc, encHistory: [] }, config: cfg };
  const file = flag(args, "out") || `cartero-device-${name || "device"}.json`;
  await writeFile(file, JSON.stringify(bundle, null, 2));
  console.log(`✓ device "${name || "device"}" certified + published`);
  console.log(`  ⚠ ${file} contains a PRIVATE KEY in cleartext — move it over a secure channel and DELETE it after importing.`);
  console.log(`  on the new device (its own CARTERO_HOME + passphrase):\n  cartero device import ${file}`);
}
async function deviceImport(args) {
  const [file] = positional(args.slice(2));
  if (!file) die("usage: cartero device import <bundle.json>");
  if (await state.hasIdentity()) die("an identity already exists here — use a fresh CARTERO_HOME");
  const bundle = JSON.parse(await readFile(file, "utf8"));
  await state.saveIdentity(bundle.identity, pass());
  await state.saveConfig(bundle.config);
  console.log(`✓ device paired — you are ${bundle.identity.id} on this device (your own key, same identity)`);
}
async function cmdDevice(args) {
  const sub = args[1];
  if (sub === "add") return deviceAdd(args);
  if (sub === "import") return deviceImport(args);
  die("usage: cartero device <add [name] | import <bundle.json>>");
}

// Publish your id -> outbox record to a registry, so others can add you by your bare id.
async function cmdRegister(args) {
  const reg = registryUrl(args) || die("set a registry: --registry <url> or $CARTERO_REGISTRY");
  const identity = await state.loadIdentity(pass());
  const cfg = await state.loadConfig() || die("run `cartero init` first");
  const rec = await buildRegistryRecord(identity, { outbox: `postal://${cfg.host}/${cfg.owner}/${cfg.repo}`, updated_at: new Date().toISOString() });
  await publishToRegistry(reg, rec);
  console.log(`✓ registered ${identity.id} -> your outbox at ${reg}`);
  console.log(`  others can now add you with:  cartero contact add ${identity.id} --registry ${reg}`);
}

// --- inbox: aggregate every conversation (contacts + groups) across all outboxes ----------
async function dmThread(identity, cfg, name, contact) {
  const peerO = peerOutbox(contact.uri);
  const peerDoc = await peerO.readIdentity(contact.id);
  if (!peerDoc) return { name, kind: "dm", messages: [] };
  peerDoc.devices = await peerO.readDevices();
  const myDoc = await publicIdentityDoc(identity); myDoc.devices = await myOutbox(cfg).readDevices();
  const directory = { [identity.id]: myDoc, [peerDoc.id]: peerDoc };
  const chat = await deriveChatId(identity.id, peerDoc.id);
  const items = [...await myOutbox(cfg).readChat(chat), ...await peerO.readChat(chat)];
  return { name, kind: "dm", messages: await resolveConversation(items, identity, { directory }) };
}
async function groupThread(identity, name) {
  const doc = await state.resolveGroup(name);
  const directory = await groupDirectory(doc);
  const merged = [];
  for (const [id, ob] of Object.entries(doc.roster || {})) merged.push(...await outboxFromUri(ob, id).readChat(doc.id));
  return { name, kind: "group", messages: await resolveGroupItems(merged, identity, { groupDoc: doc, directory }) };
}
async function cmdInbox() {
  const identity = await state.loadIdentity(pass());     // decrypt once; fan out the reads in parallel
  const cfg = await state.loadConfig() || die("run `cartero init` first");
  const contacts = await state.loadContacts(), groups = await state.loadGroups();
  const threads = await Promise.all([
    ...Object.entries(contacts).map(([n, c]) => dmThread(identity, cfg, n, c).catch(() => ({ name: n, kind: "dm", messages: [] }))),
    ...Object.keys(groups).map((n) => groupThread(identity, n).catch(() => ({ name: n, kind: "group", messages: [] }))),
  ]);
  const summary = summarizeInbox(threads);
  if (!summary.length) return console.log("(inbox vacío — agregá contactos o grupos)");
  for (const s of summary) {
    const tag = s.kind === "group" ? "#" : "@";
    const unread = s.unreadable ? `  🔒${s.unreadable}` : "";
    console.log(`${s.last.at.slice(11, 16)}  ${(tag + s.name).padEnd(14)}  ${preview(s.last)}${unread}`);
  }
}

const [cmd, sub] = process.argv.slice(2);
const args = process.argv.slice(2);
try {
  if (cmd === "init") await cmdInit(args);
  else if (cmd === "register") await cmdRegister(args);
  else if (cmd === "inbox") await cmdInbox();
  else if (cmd === "contact" && sub === "add") await cmdContactAdd(args);
  else if (cmd === "send") await cmdSend(args);
  else if (cmd === "read") await cmdRead(args);
  else if (cmd === "watch") await cmdWatch(args);
  else if (cmd === "group") await cmdGroup(args);
  else if (cmd === "device") await cmdDevice(args);
  else die("commands: init · register · inbox · contact add · send · read · watch · group · device");
} catch (e) { die(e.message); }
