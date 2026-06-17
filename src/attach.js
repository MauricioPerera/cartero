// Cartero — attachments: encrypted, content-addressed blobs referenced by hash (SPEC-F0 §6).
//
// The file bytes never go in the event. We encrypt them with a per-file key K (AES-256-GCM,
// iv prepended), address the CIPHERTEXT by SHA-256, and store it out-of-band. The event carries
// only a descriptor { name, mime, size, hash, key, locator, thumb } — and that descriptor lives
// INSIDE the sealed body, so K and the filename are E2EE. The blob store is untrusted: it holds
// ciphertext verified by `hash`.

import { sha256, bytesToBase64, base64ToBytes, randomBytes } from "../vendor/postal/src/crypto.js";

const subtle = globalThis.crypto.subtle;
const IV = 12;
const hex = (b) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");

// Encrypt file bytes. Returns { ct, hash, key } — store `ct` at blobs/<hash>, put `key`+`hash`
// in the (sealed) descriptor. `ct` = iv || AES-256-GCM(K, bytes).
export async function encryptFile(bytes) {
  const keyRaw = randomBytes(32);
  const key = await subtle.importKey("raw", keyRaw, { name: "AES-GCM" }, false, ["encrypt"]);
  const iv = randomBytes(IV);
  const enc = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv }, key, bytes));
  const ct = new Uint8Array(IV + enc.length);
  ct.set(iv, 0); ct.set(enc, IV);
  return { ct, hash: hex(await sha256(ct)), key: bytesToBase64(keyRaw) };
}

// Verify integrity (hash) then decrypt. Throws on a hash mismatch (tampered/wrong blob) BEFORE
// attempting decryption, so a swapped blob is caught explicitly.
export async function decryptFile(ct, keyB64, expectHash) {
  ct = ct instanceof Uint8Array ? ct : new Uint8Array(ct);
  if (expectHash && hex(await sha256(ct)) !== expectHash) throw new Error("attachment hash mismatch");
  const iv = ct.slice(0, IV);
  const key = await subtle.importKey("raw", base64ToBytes(keyB64), { name: "AES-GCM" }, false, ["decrypt"]);
  return new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv }, key, ct.slice(IV)));
}

// Build the descriptor that goes (sealed) in the event body. `locator` defaults to the in-repo
// blob path (MVP); a pluggable store would supply its own locator.
export function makeDescriptor({ name, mime, size, hash, key, locator, thumb = null }) {
  return { name: String(name || ""), mime: String(mime || "application/octet-stream"), size, hash, key, locator: locator || `blobs/${hash}`, thumb };
}
