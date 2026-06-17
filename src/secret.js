// Cartero — encrypt the local identity (private keys) at rest with a passphrase (SPEC-F0 §10).
// PBKDF2-SHA256 -> AES-256-GCM. The on-disk blob is useless without the passphrase.

import { randomBytes, bytesToBase64, base64ToBytes, utf8Bytes, utf8Text } from "../vendor/postal/src/crypto.js";

const subtle = globalThis.crypto.subtle;
const ITER = 210000;

async function deriveKey(passphrase, salt) {
  const base = await subtle.importKey("raw", utf8Bytes(passphrase), "PBKDF2", false, ["deriveKey"]);
  return subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: ITER, hash: "SHA-256" },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export async function sealSecret(obj, passphrase) {
  if (!passphrase) throw new Error("a passphrase is required");
  const salt = randomBytes(16), iv = randomBytes(12);
  const key = await deriveKey(passphrase, salt);
  const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv }, key, utf8Bytes(JSON.stringify(obj))));
  return { v: 1, kdf: "PBKDF2-SHA256", iter: ITER, salt: bytesToBase64(salt), iv: bytesToBase64(iv), ct: bytesToBase64(ct) };
}

export async function openSecret(blob, passphrase) {
  const key = await deriveKey(passphrase, base64ToBytes(blob.salt));
  let pt;
  try { pt = await subtle.decrypt({ name: "AES-GCM", iv: base64ToBytes(blob.iv) }, key, base64ToBytes(blob.ct)); }
  catch { throw new Error("wrong passphrase or corrupt identity file"); }
  return JSON.parse(utf8Text(new Uint8Array(pt)));
}
