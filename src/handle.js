// Cartero F2 — human-readable addresses: `user@domain`, resolved WebFinger-style to a key + outbox
// via a SIGNED binding served over HTTPS. Double attestation: the DOMAIN serves it (TLS proves
// domain control) and the KEY signs it (consents to the handle↔id↔outbox binding). The id stays
// the real identity, so the handle is a portable, disposable alias (SPEC-F0 §2 / §11 F2).
//
//   handle  user@domain   ->   https://domain/.well-known/postal/user.json
//   doc     { v, handle, domain, id, sign_key, outbox, sig }

import { canonical, fingerprintId, importSignPublic, importSignPrivate, sign, verify } from "../vendor/postal/src/crypto.js";

const stripSig = (d) => { const { sig, ...rest } = d; return rest; };

export function parseHandle(h) {
  const m = /^([^@\s/]+)@([^@\s/]+\.[^@\s/]+)$/.exec(String(h).trim());
  if (!m) throw new Error("invalid handle (expected user@domain)");
  return { user: m[1], domain: m[2], handle: `${m[1]}@${m[2]}` };
}

export function wellKnownUrl(handle) {
  const { user, domain } = parseHandle(handle);
  return `https://${domain}/.well-known/postal/${user}.json`;
}

// Build the signed binding to publish at your domain's .well-known. `outbox` is your repo URI.
export async function buildHandleDoc(identity, { handle, outbox }) {
  const { domain } = parseHandle(handle);
  const doc = { v: 1, handle, domain, id: identity.id, sign_key: { alg: "ECDSA-P256", pub: identity.sign.publicKey }, outbox };
  const priv = await importSignPrivate(identity.sign.privateJwk);
  doc.sig = await sign(priv, canonical(stripSig(doc)));
  return doc;
}

// Verify a fetched binding against the handle the user typed: the doc must claim exactly that
// handle+domain, its key's fingerprint must equal its `id`, and its self-signature must be valid.
export async function verifyHandleDoc(doc, handle) {
  try {
    const want = parseHandle(handle);
    if (!doc || doc.v !== 1 || doc.handle !== want.handle || doc.domain !== want.domain) return false;
    if (!doc.sign_key || !doc.sign_key.pub || !doc.id || !doc.outbox || !doc.sig) return false;
    if (await fingerprintId(doc.sign_key.pub) !== doc.id) return false;           // key really IS this id
    return await verify(await importSignPublic(doc.sign_key.pub), doc.sig, canonical(stripSig(doc)));  // key consented
  } catch { return false; }
}

// Resolve `user@domain` -> { handle, id, outbox }. `fetchImpl` is injectable for tests; in
// production it's global fetch (HTTPS = the domain-control proof).
export async function resolveHandle(handle, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(wellKnownUrl(handle));
  if (!res.ok) throw new Error(`handle not found (HTTP ${res.status})`);
  const doc = await res.json();
  if (!await verifyHandleDoc(doc, handle)) throw new Error("handle binding failed verification");
  return { handle: doc.handle, id: doc.id, outbox: doc.outbox };
}
