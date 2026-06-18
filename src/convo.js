// Cartero — the 1:1 conversation: chat_id derivation, sealed DM events, the gate, and the
// two-outbox merge. Built on Postal primitives (SPEC-F0 §3–§5, §8–§9).

import { canonical, sha256, utf8Bytes, sealAnonymous, openAnonymous } from "../vendor/postal/src/crypto.js";
import { buildEvent, verifyEvent, eventPath, MARKER } from "../vendor/postal/src/postal.js";
import { canonicalOrder } from "../vendor/postal/src/order.js";
import { recipientEncKeys, deviceShim } from "./device.js";

const hex = (b) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
const encode = (obj) => btoa(unescape(encodeURIComponent(JSON.stringify(obj))));
const decode = (b64) => JSON.parse(decodeURIComponent(escape(atob(b64))));

// Enc keys to seal to for an identity: master + every certified device (so any of their devices
// reads). Falls back to a bare enc pub when no doc is available.
async function sealKeys(doc, fallbackPub) {
  if (!doc) return fallbackPub ? [fallbackPub] : [];
  return recipientEncKeys(doc, doc.devices || []);
}

// chat_id = "dm_" + first 32 hex of SHA-256(sorted ids joined by "|"). Both parties compute it
// without coordinating; an outsider can't read the participants from the directory name.
export async function deriveChatId(idA, idB) {
  return "dm_" + hex(await sha256(utf8Bytes([idA, idB].sort().join("|")))).slice(0, 32);
}

// AAD binds a sealed envelope to its exact event (same as Postal's message AAD), so the envelope
// can't be relocated to another event/chat.
const aadOf = (chat_id, from, to, id, created_at) => canonical({ chat_id, from, to: [...to].sort(), id, created_at });

// Build a SEALED DM. `content` = { text, reply_to, attachments } is sealed whole (richer than
// Postal's message kind, which only seals `text`). `directory` provides the peer's enc pubkey.
export async function buildDm(me, peerId, content, { created_at, rnd, seq = null, prev = null, directory }) {
  const chat_id = await deriveChatId(me.id, peerId);
  const to = [peerId];
  const id = created_at.replace(/[:.]/g, "-") + "_" + me.id + "_" + rnd;   // must match buildEvent's id
  const aad = aadOf(chat_id, me.id, to, id, created_at);
  // Seal to BOTH parties' master + device enc keys, so the sender's own devices AND any of the
  // recipient's devices can read. Anonymous sealing -> the envelope never names the recipients.
  const pubs = [...new Set([
    ...await sealKeys(directory[me.id], me.enc && me.enc.publicKey),
    ...await sealKeys(directory[peerId]),
  ])];
  // keySlots is a FIXED bucket (not pubs.length): sealAnonymous pads slots to padToBucket(n, 4),
  // so an observer sees n rounded up to a multiple of 4, never the exact recipient/device count.
  const envelope = await sealAnonymous(JSON.stringify(content), pubs, aad, { keySlots: 4 });
  const body = { sealed: MARKER + encode(envelope) };
  return buildEvent(me, { kind: "dm", chat_id, to, created_at, rnd, body, seq, prev });
}

// Decrypt a DM as `me` (this device's enc key, then rotated-out keys). Anonymous: we trial-unwrap.
export async function openDm(ev, me) {
  if (ev.kind !== "dm" || !ev.body || String(ev.body.sealed || "").indexOf(MARKER) !== 0) return null;
  const envelope = decode(String(ev.body.sealed).slice(MARKER.length));
  const aad = aadOf(ev.chat_id, ev.from, ev.to, ev.id, ev.created_at);
  let lastErr;
  for (const e of [me.enc, ...(me.encHistory || [])]) {
    try { return JSON.parse(await openAnonymous(envelope, e.privateJwk, aad)); }
    catch (err) { lastErr = err; }
  }
  throw lastErr || new Error("cannot open");
}

// The Cartero gate: Postal's verifyEvent + structural DM rules (SPEC-F0 §8), now DEVICE-AWARE: an
// event may be signed by the master key OR a certified device of `from`. We find the signing key
// and, if it's a device, shim it into the directory so verifyEvent checks the signature against it.
export async function verifyDm(ev, { directory, seenPaths } = {}) {
  const reasons = [];
  if (ev.kind !== "dm") reasons.push("not-dm");
  if (!/^[A-Za-z0-9_-]+$/.test(ev.id || "")) reasons.push("bad-id");   // defense-in-depth: no HTML/inject chars
  const oneRecipient = Array.isArray(ev.to) && ev.to.length === 1;
  if (!oneRecipient) reasons.push("dm-needs-one-recipient");
  else if (ev.from === ev.to[0]) reasons.push("self-dm");
  else if (ev.chat_id !== await deriveChatId(ev.from, ev.to[0])) reasons.push("chat-id-mismatch");
  const members = oneRecipient ? [{ id: ev.from }, { id: ev.to[0] }] : [{ id: ev.from }];
  const dir = await deviceShim(directory, ev);
  const base = await verifyEvent(ev, { directory: dir, seenPaths, members });
  return { ok: reasons.length === 0 && base.ok, reasons: [...reasons, ...base.reasons] };
}

// Resolve a conversation from items merged across BOTH outboxes. items: [{ path, event }].
// Gate-rejected events are dropped; valid ones are decrypted (when addressed to me) and ordered
// with Postal's canonicalOrder — which, across two repos, falls back to created_at+id (no global
// commit order between independent repos); `reply_to` carries the causal order (SPEC-F0 §9).
export async function resolveConversation(items, me, { directory } = {}) {
  const seenPaths = new Set();
  const kept = [];
  for (const it of items) {
    const ev = it.event;
    const v = await verifyDm(ev, { directory, seenPaths });
    if (!v.ok) continue;
    seenPaths.add(eventPath(ev.chat_id, ev));   // only a VALID event reserves its path: an invalid
    // event (e.g. a forgery copying a real id) must not poison the path and suppress the real one.
    let content = null;
    try { content = await openDm(ev, me); } catch {}
    kept.push({ event: ev, content });
  }
  return canonicalOrder(kept.map((k) => ({ event: k.event, _k: k }))).map(({ _k }) => ({
    id: _k.event.id, from: _k.event.from, at: _k.event.created_at,
    mine: _k.event.from === me.id,
    text: _k.content ? _k.content.text : null,
    reply_to: _k.content ? _k.content.reply_to || null : null,
    attachments: _k.content ? _k.content.attachments || [] : [],
    readable: !!_k.content,
  }));
}
