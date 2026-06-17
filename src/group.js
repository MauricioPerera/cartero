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

import { canonical, sha256, utf8Bytes, sealForRecipients, openSealed, importSignPrivate, importSignPublic, sign, verify } from "../vendor/postal/src/crypto.js";
import { buildEvent, verifyEvent, eventPath, MARKER } from "../vendor/postal/src/postal.js";
import { canonicalOrder } from "../vendor/postal/src/order.js";

const encode = (o) => btoa(unescape(encodeURIComponent(JSON.stringify(o))));
const decode = (b) => JSON.parse(decodeURIComponent(escape(atob(b))));
const stripSig = (d) => { const { sig, ...rest } = d; return rest; };
const aadOf = (chat_id, from, to, id, created_at) => canonical({ chat_id, from, to: [...to].sort(), id, created_at });

// Create a signed group doc. `members` includes the creator. `rnd` makes the id unique.
export async function buildGroupDoc(creator, { name = "", members, created_at, rnd }) {
  const set = [...new Set([creator.id, ...members])].sort();
  const doc = { v: 1, id: `grp_${creator.id}_${rnd}`, name: String(name), creator: creator.id, members: set, created_at };
  doc.sig = await sign(await importSignPrivate(creator.sign.privateJwk), canonical(stripSig(doc)));
  return doc;
}

// Verify a group doc: id is anchored to creator, creator is known, and the creator signed it.
export async function verifyGroupDoc(doc, { directory } = {}) {
  try {
    if (!doc || doc.v !== 1 || !Array.isArray(doc.members) || !doc.creator || !doc.sig) return false;
    if (doc.id !== `grp_${doc.creator}_${doc.id.split("_")[2] || ""}` ) return false;   // id embeds the creator
    if (!doc.members.includes(doc.creator)) return false;
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
  const recipients = groupDoc.members.map((mid) => ({ id: mid, encPublicKey: directory[mid].enc_key.pub }));
  const envelope = await sealForRecipients(JSON.stringify(content), recipients, aad);
  return buildEvent(me, { kind: "gm", chat_id, to, created_at, rnd, body: { sealed: MARKER + encode(envelope) }, seq, prev });
}

export async function openGm(ev, me) {
  if (ev.kind !== "gm" || !ev.body || String(ev.body.sealed || "").indexOf(MARKER) !== 0) return null;
  const envelope = decode(String(ev.body.sealed).slice(MARKER.length));
  const aad = aadOf(ev.chat_id, ev.from, ev.to, ev.id, ev.created_at);
  let lastErr;
  for (const e of [me.enc, ...(me.encHistory || [])]) {
    try { return JSON.parse(await openSealed(envelope, me.id, e.privateJwk, aad)); }
    catch (err) { lastErr = err; }
  }
  throw lastErr || new Error("cannot open");
}

// Gate a group message: Postal's verifyEvent + structural rules (kind, chat_id == group, author is
// a member of THIS group doc).
export async function verifyGm(ev, { groupDoc, directory, seenPaths } = {}) {
  const reasons = [];
  if (ev.kind !== "gm") reasons.push("not-gm");
  if (!groupDoc || ev.chat_id !== groupDoc.id) reasons.push("wrong-group");
  else if (!groupDoc.members.includes(ev.from)) reasons.push("author-not-member");
  const members = groupDoc ? groupDoc.members.map((id) => ({ id })) : undefined;
  const base = await verifyEvent(ev, { directory, seenPaths, members });
  return { ok: reasons.length === 0 && base.ok, reasons: [...reasons, ...base.reasons] };
}

// Resolve a group from items merged across all members' outboxes. items: [{ path, event }].
export async function resolveGroup(items, me, { groupDoc, directory } = {}) {
  const seenPaths = new Set();
  const kept = [];
  for (const it of items) {
    const ev = it.event;
    const v = await verifyGm(ev, { groupDoc, directory, seenPaths });
    seenPaths.add(eventPath(ev.chat_id, ev));
    if (!v.ok) continue;
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
