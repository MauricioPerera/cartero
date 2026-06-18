// Cartero F3 — group conversations (N participants), built on the same primitives as 1:1 DMs.
//
// A group is a SIGNED doc the creator publishes: { id, name, creator, members[], created_at, sig }.
// id = "grp_<creator>_<rnd>" (anchored to the creator). Membership for the MVP is creator-managed
// (the creator's signed member list) — full quorum governance is Postal's heavier model, deferred.
// Each member posts group messages (kind "gm") to THEIR OWN outbox under the group's chat_id,
// SEALED to all members; reading is the merge of every member's outbox (federated, no shared write).
//
// HONEST LIMITS: creator manages membership (no quorum); removing a member does NOT re-key past
// messages (they were sealed to that member, who can still read the old ones — no forward secrecy);
// to read you need every member's outbox (resolve them from the directory / their handles).
// The group doc has NO monotonic version: an OLD doc (with a since-removed member) stays
// signature-valid, and joiners cache the doc locally without re-fetching, so a membership change
// does NOT propagate to existing members until they re-join. Anti-rollback (a signed, monotonic
// roster version the gate enforces) is future work, not in this MVP.

import { canonical, sha256, utf8Bytes, sealAnonymous, openAnonymous, importSignPrivate, importSignPublic, sign, verify } from "../vendor/postal/src/crypto.js";
import { buildEvent, verifyEvent, eventPath, MARKER } from "../vendor/postal/src/postal.js";
import { canonicalOrder } from "../vendor/postal/src/order.js";
import { recipientEncKeys, deviceShim } from "./device.js";

const encode = (o) => btoa(unescape(encodeURIComponent(JSON.stringify(o))));
const decode = (b) => JSON.parse(decodeURIComponent(escape(atob(b))));
const stripSig = (d) => { const { sig, ...rest } = d; return rest; };
const aadOf = (chat_id, from, to, id, created_at) => canonical({ chat_id, from, to: [...to].sort(), id, created_at });

// Create a signed group doc. `members` includes the creator (ids). Optional `roster` (id->outbox
// URI) makes the doc self-contained so a joiner can find every member's outbox from one fetch; it
// is part of the signed payload. `rnd` makes the id unique.
export async function buildGroupDoc(creator, { name = "", members, roster, created_at, rnd }) {
  const set = [...new Set([creator.id, ...members])].sort();
  const doc = { v: 1, id: `grp_${creator.id}_${rnd}`, name: String(name), creator: creator.id, members: set, created_at };
  if (roster) doc.roster = roster;
  doc.sig = await sign(await importSignPrivate(creator.sign.privateJwk), canonical(stripSig(doc)));
  return doc;
}

// Verify a group doc: id is anchored to creator, creator is known, and the creator signed it.
export async function verifyGroupDoc(doc, { directory } = {}) {
  try {
    if (!doc || doc.v !== 1 || !Array.isArray(doc.members) || !doc.creator || !doc.sig) return false;
    if (doc.id !== `grp_${doc.creator}_${doc.id.split("_")[2] || ""}` ) return false;   // id embeds the creator
    if (!doc.members.includes(doc.creator)) return false;
    // roster (id -> outbox) must name ONLY members: an entry for a non-member would make readers
    // fetch an arbitrary outbox the creator listed (metadata leak / DoS), even though the gate
    // already rejects a non-member's messages via author-not-member.
    if (doc.roster && (typeof doc.roster !== "object" || !Object.keys(doc.roster).every((id) => doc.members.includes(id)))) return false;
    const author = directory && directory[doc.creator];
    if (!author) return false;
    return await verify(await importSignPublic(author.sign_key.pub), doc.sig, canonical(stripSig(doc)));
  } catch { return false; }
}

// Build a SEALED group message. Sealed to ALL members (so the sender reads their own sent too);
// `to` lists the other members. `directory` supplies every member's enc pubkey.
export async function buildGm(me, groupDoc, content, { created_at, rnd, seq = null, prev = null, directory }) {
  const chat_id = groupDoc.id;
  const to = groupDoc.members.filter((id) => id !== me.id);
  const id = created_at.replace(/[:.]/g, "-") + "_" + me.id + "_" + rnd;
  const aad = aadOf(chat_id, me.id, to, id, created_at);
  // Seal to EVERY member's master + device enc keys, so any device of any member can read.
  const pubs = [];
  for (const mid of groupDoc.members) for (const k of await recipientEncKeys(directory[mid], (directory[mid] || {}).devices || [])) pubs.push(k);
  const set = [...new Set(pubs)];
  // keySlots is a FIXED bucket (not set.length): slots pad to padToBucket(n, 4), so an observer
  // sees the recipient count rounded up to a multiple of 4 — not the exact group/device size.
  const envelope = await sealAnonymous(JSON.stringify(content), set, aad, { keySlots: 4 });
  return buildEvent(me, { kind: "gm", chat_id, to, created_at, rnd, body: { sealed: MARKER + encode(envelope) }, seq, prev });
}

// SECURITY CONTRACT: like openDm, openGm only DECRYPTS — it does not authenticate. Always gate with
// verifyGm first and discard rejected events. resolveGroup does this (verify, then open).
export async function openGm(ev, me) {
  if (ev.kind !== "gm" || !ev.body || String(ev.body.sealed || "").indexOf(MARKER) !== 0) return null;
  const envelope = decode(String(ev.body.sealed).slice(MARKER.length));
  const aad = aadOf(ev.chat_id, ev.from, ev.to, ev.id, ev.created_at);
  let lastErr;
  for (const e of [me.enc, ...(me.encHistory || [])]) {
    try { return JSON.parse(await openAnonymous(envelope, e.privateJwk, aad)); }
    catch (err) { lastErr = err; }
  }
  throw lastErr || new Error("cannot open");
}

// Gate a group message: Postal's verifyEvent + structural rules (kind, chat_id == group, author is
// a member of THIS group doc).
export async function verifyGm(ev, { groupDoc, directory, seenPaths } = {}) {
  const reasons = [];
  if (ev.kind !== "gm") reasons.push("not-gm");
  if (!/^[A-Za-z0-9_-]+$/.test(ev.id || "")) reasons.push("bad-id");   // defense-in-depth: no HTML/inject chars
  if (!groupDoc || ev.chat_id !== groupDoc.id) reasons.push("wrong-group");
  else if (!groupDoc.members.includes(ev.from)) reasons.push("author-not-member");
  const members = groupDoc ? groupDoc.members.map((id) => ({ id })) : undefined;
  const dir = await deviceShim(directory, ev);            // accept a certified device's signature
  const base = await verifyEvent(ev, { directory: dir, seenPaths, members });
  return { ok: reasons.length === 0 && base.ok, reasons: [...reasons, ...base.reasons] };
}

// Resolve a group from items merged across all members' outboxes. items: [{ path, event }].
export async function resolveGroup(items, me, { groupDoc, directory } = {}) {
  const seenPaths = new Set();
  const kept = [];
  for (const it of items) {
    const ev = it.event;
    const v = await verifyGm(ev, { groupDoc, directory, seenPaths });
    if (!v.ok) continue;
    seenPaths.add(eventPath(ev.chat_id, ev));   // only a VALID event reserves its path: an invalid
    // event (e.g. a forgery copying a real id) must not poison the path and suppress the real one.
    let content = null;
    try { content = await openGm(ev, me); } catch {}
    kept.push({ event: ev, content });
  }
  return canonicalOrder(kept.map((k) => ({ event: k.event, _k: k }))).map(({ _k }) => ({
    id: _k.event.id, from: _k.event.from, at: _k.event.created_at, mine: _k.event.from === me.id,
    text: _k.content ? _k.content.text : null, reply_to: _k.content ? _k.content.reply_to || null : null,
    attachments: _k.content ? _k.content.attachments || [] : [], readable: !!_k.content,
  }));
}
