// Cartero F4 — discovery: resolve a bare id -> outbox via a registry, so you can share just your
// short id (postal:<id>) instead of a full URI. A registry record is SELF-SIGNED:
//   { v, id, sign_key, outbox, updated_at, sig }
// Only you can claim your own id (id = fingerprint(sign_key)), so squatting is impossible. The
// registry is an UNTRUSTED, OPTIONAL convenience — it can refuse to serve (use another registry or
// share your URI/handle directly) but it can't forge a mapping or read anything. Resolvers verify
// every record locally, so a malicious registry can't point you at someone else's outbox.

import { canonical, fingerprintId, importSignPrivate, importSignPublic, sign, verify } from "../vendor/postal/src/crypto.js";

const stripSig = (d) => { const { sig, ...rest } = d; return rest; };

export async function buildRegistryRecord(identity, { outbox, updated_at }) {
  const rec = { v: 1, id: identity.id, sign_key: { alg: "ECDSA-P256", pub: identity.sign.publicKey }, outbox, updated_at: updated_at || "" };
  rec.sig = await sign(await importSignPrivate(identity.sign.privateJwk), canonical(stripSig(rec)));
  return rec;
}

// Verify a record is internally consistent: the key's fingerprint IS the id, and the id's key
// signed the (id -> outbox) binding. No registry/host is trusted in this check.
export async function verifyRegistryRecord(rec) {
  try {
    if (!rec || rec.v !== 1 || !rec.id || !rec.sign_key || !rec.sign_key.pub || !rec.outbox || !rec.sig) return false;
    if (await fingerprintId(rec.sign_key.pub) !== rec.id) return false;     // key really IS this id
    return await verify(await importSignPublic(rec.sign_key.pub), rec.sig, canonical(stripSig(rec)));
  } catch { return false; }
}

// Publish your record to a registry (best-effort POST). `fetchImpl` injectable for tests.
export async function publishToRegistry(registryUrl, record, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(registryUrl.replace(/\/$/, "") + "/register", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(record),
  });
  if (!res.ok) throw new Error(`registry rejected the record (HTTP ${res.status})`);
  return true;
}

// Resolve a bare id -> { id, outbox } via a registry, verifying the returned record locally.
export async function resolveId(registryUrl, id, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(registryUrl.replace(/\/$/, "") + "/id/" + encodeURIComponent(id));
  if (!res.ok) throw new Error(`id not found in registry (HTTP ${res.status})`);
  const rec = await res.json();
  if (rec.id !== id || !(await verifyRegistryRecord(rec))) throw new Error("registry record failed verification");
  return { id: rec.id, outbox: rec.outbox };
}
