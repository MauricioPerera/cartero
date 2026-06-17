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
    async getBlob(locator) { const f = await client.getFile(locator); return f ? base64ToBytes(f.content) : null; },

    // Commit a DM event plus any attachment blobs in ONE commit. `item` = { path, event }.
    async appendEvent(item, blobFiles = []) {
      await client.commitFiles(
        [{ path: item.path, content: JSON.stringify(item.event, null, 2) }, ...blobFiles],
        `cartero: dm ${item.event.id}`);
    },

    // Group docs published in this outbox (so members can fetch the signed roster).
    async publishGroup(doc) { await client.putFile(`.postal/groups/${doc.id}.json`, JSON.stringify(doc, null, 2), `cartero: group ${doc.id}`); },
    async readGroup(id) { const f = await client.getFile(`.postal/groups/${id}.json`); if (!f) return null; try { return JSON.parse(f.content); } catch { return null; } },

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

    // Next (seq, prev) for MY chain in this chat: seq = count of my events, prev = hash of my last.
    // Reuses Postal's eventHash via the caller (kept here as the count; prev computed by caller).
    async myChainCount(chat_id, myId) {
      return (await this.readChat(chat_id)).filter((it) => it.event.from === myId).length;
    },
  };
}

export { eventPath };
