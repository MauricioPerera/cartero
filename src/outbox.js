// Cartero — the outbox: a git repo holding your published identity, your DM events, and your
// encrypted attachment blobs. Built on Postal's GitHub transport (ghClient). Each user writes
// ONLY their own outbox; the conversation is the merge of both (SPEC-F0 §0, §9).
//
// Binary note: ghClient stores/reads file content as UTF-8 text, so attachment ciphertext is
// kept BASE64-encoded at blobs/<hash> (text-safe); the hash is over the RAW ciphertext bytes.

import { ghClient } from "../vendor/postal/src/github.js";
import { userPath, eventPath, verifyIdentityDoc } from "../vendor/postal/src/postal.js";
import { bytesToBase64, base64ToBytes } from "../vendor/postal/src/crypto.js";

export function outbox({ host = "github.com", owner, repo, token, branch = "main", client } = {}) {
  client = client || ghClient({ owner, repo, token, branch });
  return {
    host, owner, repo, client,
    uri: (id) => `postal://${host}/${owner}/${repo}#${id}`,

    async publishIdentity(doc) {
      await client.putFile(userPath(doc.id), JSON.stringify(doc, null, 2), `cartero: publish identity ${doc.id}`);
    },
    // Read + cryptographically verify a published identity doc (id anchors to key, self-sig ok).
    async readIdentity(id) {
      const f = await client.getFile(userPath(id));
      if (!f) return null;
      try { const d = JSON.parse(f.content); return (await verifyIdentityDoc(d)) ? d : null; } catch { return null; }
    },

    // Blob file for an encrypted attachment (base64 text). Returns a { path, content } to commit.
    blobFile(hash, ct) { return { path: `blobs/${hash}`, content: bytesToBase64(ct) }; },
    // Fetch an encrypted blob. Uses GitHub's RAW media type (streams up to 100MB); the plain
    // Contents API silently truncates files over 1MB, which would break any attachment whose stored
    // base64 exceeds that. `maxBytes` bounds what a PEER can make you download/decrypt — the
    // descriptor's `size` is self-asserted, so we cap the ACTUAL bytes before returning them.
    async getBlob(locator, maxBytes) {
      let bytes;
      if (token && owner && repo) {
        const path = String(locator).split("/").map(encodeURIComponent).join("/");
        const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`,
          { headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github.raw", "X-GitHub-Api-Version": "2022-11-28" } });
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`getBlob ${locator}: HTTP ${res.status}`);
        // Reject BEFORE buffering the body when the size is known: the stored blob is base64 text,
        // so its byte length is ~4/3 of the ct. (Backstop below caps real bytes if the header lies.)
        const clen = Number(res.headers.get("content-length") || 0);
        if (maxBytes && clen > Math.ceil((maxBytes + 65536) * 4 / 3)) throw new Error(`attachment too large to download: ${(clen * 3 / 4 / 1048576).toFixed(1)} MB > ${(maxBytes / 1048576).toFixed(0)} MB cap`);
        bytes = base64ToBytes(String(await res.text()).trim());     // we stored base64 TEXT; raw returns it
      } else {
        const f = await client.getFile(locator); if (!f) return null; bytes = base64ToBytes(f.content);
      }
      if (maxBytes && bytes.length > maxBytes + 65536) throw new Error(`attachment too large to download: ${(bytes.length / 1048576).toFixed(1)} MB > ${(maxBytes / 1048576).toFixed(0)} MB cap`);
      return bytes;
    },

    // Commit a DM event plus any attachment blobs in ONE commit. `item` = { path, event }.
    async appendEvent(item, blobFiles = []) {
      await client.commitFiles(
        [{ path: item.path, content: JSON.stringify(item.event, null, 2) }, ...blobFiles],
        `cartero: dm ${item.event.id}`);
    },

    // Group docs published in this outbox (so members can fetch the signed roster).
    async publishGroup(doc) { await client.putFile(`.postal/groups/${doc.id}.json`, JSON.stringify(doc, null, 2), `cartero: group ${doc.id}`); },
    async readGroup(id) { const f = await client.getFile(`.postal/groups/${id}.json`); if (!f) return null; try { return JSON.parse(f.content); } catch { return null; } },

    // Published device certs for THIS identity (multi-device). The list the gate/sealing consult.
    async publishDevices(certs) { await client.putFile(`.postal/devices.json`, JSON.stringify(certs, null, 2), `cartero: devices (${certs.length})`); },
    async readDevices() { const f = await client.getFile(`.postal/devices.json`); if (!f) return []; try { const d = JSON.parse(f.content); return Array.isArray(d) ? d : []; } catch { return []; } },

    // Read all events of a chat from THIS outbox. items: [{ path, event }].
    async readChat(chat_id) {
      const prefix = `.postal/chats/${chat_id}/events/`;
      const items = [];
      for (const p of (await client.listTree(prefix)).filter((p) => p.indexOf(prefix) === 0 && p.endsWith(".json")).sort()) {
        const f = await client.getFile(p);
        if (f) { try { items.push({ path: p, event: JSON.parse(f.content) }); } catch {} }
      }
      return items;
    },

  };
}

export { eventPath };
