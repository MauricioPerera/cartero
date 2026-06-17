// Cartero — local client state under ~/.cartero/ : your (encrypted) identity, your outbox config,
// and your contacts/petnames (SPEC-F0 §10). Plain Node fs; no secrets in cleartext on disk.

import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { sealSecret, openSecret } from "./secret.js";

const DIR = process.env.CARTERO_HOME || join(homedir(), ".cartero");
const idFile = join(DIR, "identity.json");       // encrypted with the passphrase
const cfgFile = join(DIR, "config.json");        // { host, owner, repo } = my outbox
const contactsFile = join(DIR, "contacts.json"); // { petname: { id, uri, verified, verified_at } }

const readJson = async (f, dflt) => { try { return JSON.parse(await readFile(f, "utf8")); } catch { return dflt; } };
const writeJson = async (f, v) => { await mkdir(DIR, { recursive: true }); await writeFile(f, JSON.stringify(v, null, 2)); };

export async function saveIdentity(identity, passphrase) { await writeJson(idFile, await sealSecret(identity, passphrase)); }
export async function loadIdentity(passphrase) {
  const blob = await readJson(idFile, null);
  if (!blob) throw new Error("no identity — run `cartero init` first");
  return openSecret(blob, passphrase);
}
export async function hasIdentity() { return (await readJson(idFile, null)) !== null; }

export const loadConfig = () => readJson(cfgFile, null);
export const saveConfig = (cfg) => writeJson(cfgFile, cfg);

export const loadContacts = () => readJson(contactsFile, {});
export async function saveContact(petname, contact) {
  const all = await loadContacts();
  all[petname] = contact;
  await writeJson(contactsFile, all);
}
export async function resolveContact(petname) {
  const c = (await loadContacts())[petname];
  if (!c) throw new Error(`unknown contact: ${petname}`);
  return c;
}

export const stateDir = DIR;
