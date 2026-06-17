// Cartero — the shareable address: postal://<host>/<owner>/<repo>#<fingerprint>
//
// `<host>/<owner>/<repo>` locates the outbox repo (the "where"); `#<fingerprint>` is the
// identity id (the "who", first 64 bits of SHA-256(sign key) = 16 hex). See SPEC-F0 §2.

export function buildUri({ host, owner, repo, id }) {
  for (const [k, v] of Object.entries({ host, owner, repo, id })) {
    if (!v || /[\s/#]/.test(String(v))) throw new Error(`invalid uri part: ${k}`);
  }
  if (!/^[0-9a-fA-F]{16}$/.test(id)) throw new Error("fingerprint must be 16 hex chars");
  return `postal://${host}/${owner}/${repo}#${id}`;
}

export function parseUri(uri) {
  const m = /^postal:\/\/([^/\s]+)\/([^/\s]+)\/([^/#\s]+)#([0-9a-fA-F]{16})$/.exec(String(uri).trim());
  if (!m) throw new Error("invalid postal URI");
  return { host: m[1], owner: m[2], repo: m[3], id: m[4] };
}
