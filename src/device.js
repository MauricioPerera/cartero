// Cartero F3 — multi-device. One identity (id = the master sign key's fingerprint) authorizes
// several DEVICE keys via signed certs, so each device holds its OWN key instead of copying the
// master private key around. A device acts AS the identity: its events carry `from = <master id>`
// but are signed by the device key; a verifier accepts the signature if it matches ANY key the
// master authorized (master + valid device certs) — no `device` field and NO postal-core change.
//
// To let any of a recipient's devices READ, a sender seals to ALL the recipient's enc keys
// (master + devices) — see recipientEncKeys (wire into convo/group sealing, e.g. via sealAnonymous).
//
// HONEST LIMITS: the master key issues device certs (no per-device revocation list yet beyond
// dropping the cert); a leaked device key is valid until its cert is removed from the published set.

import { canonical, importSignPrivate, importSignPublic, sign, verify } from "../vendor/postal/src/crypto.js";

const stripSig = (d) => { const { sig, ...rest } = d; return rest; };
const signedView = (ev) => { const { sig, attestations, ...rest } = ev; return rest; };

// The master signs a cert authorizing a device's sign + enc public keys. `device` is a keypair
// object ({ sign:{publicKey,...}, enc:{publicKey,...} }, e.g. a fresh createIdentity()).
export async function buildDeviceCert(master, device, { name = "", created_at } = {}) {
  const cert = { v: 1, identity: master.id, name: String(name), device_sign: device.sign.publicKey, device_enc: device.enc.publicKey, created_at: created_at || "" };
  cert.sig = await sign(await importSignPrivate(master.sign.privateJwk), canonical(stripSig(cert)));
  return cert;
}

// Verify a device cert names THIS identity and is signed by its master sign key.
export async function verifyDeviceCert(cert, masterDoc) {
  try {
    if (!cert || cert.v !== 1 || !masterDoc || cert.identity !== masterDoc.id) return false;
    if (!cert.device_sign || !cert.device_enc || !cert.sig) return false;
    return await verify(await importSignPublic(masterDoc.sign_key.pub), cert.sig, canonical(stripSig(cert)));
  } catch { return false; }
}

// Sign keys allowed to author for this identity: the master + every validly-certified device.
export async function authorizedSignKeys(masterDoc, certs = []) {
  const keys = [masterDoc.sign_key.pub];
  for (const c of certs) if (await verifyDeviceCert(c, masterDoc)) keys.push(c.device_sign);
  return keys;
}

// Enc keys to seal to so ANY of this identity's devices can read: master + every certified device.
export async function recipientEncKeys(masterDoc, certs = []) {
  const keys = [masterDoc.enc_key.pub];
  for (const c of certs) if (await verifyDeviceCert(c, masterDoc)) keys.push(c.device_enc);
  return keys;
}

// True if `ev` (from = this identity) was signed by an authorized key — master OR a certified
// device. This is the device-aware signature check; layer it into the gate for multi-device.
export async function verifyDeviceSignedEvent(ev, masterDoc, certs = []) {
  const payload = canonical(signedView(ev));
  for (const k of await authorizedSignKeys(masterDoc, certs)) {
    try { if (await verify(await importSignPublic(k), ev.sig, payload)) return true; } catch { /* try next */ }
  }
  return false;
}
