# Cartero

[![CI](https://github.com/MauricioPerera/cartero/actions/workflows/ci.yml/badge.svg)](https://github.com/MauricioPerera/cartero/actions/workflows/ci.yml)

**A sovereign, end-to-end-encrypted messenger that runs on git.** Your identity is a key, your
mailbox is a git repo you can migrate, and any client that speaks the protocol works. No
messaging server to trust, no phone number, no provider that can deplatform you without you
keeping everything.

Built on the [postal](https://github.com/MauricioPerera/postal) protocol (vendored as a git
submodule). DMs and groups, text + file attachments, key-based identity, `user@domain` handles,
id-based discovery, an optional real-time relay, a CLI, and a web UI.

> [!WARNING]
> **Experimental — MVP, not security-audited.** The cryptographic core is signed (ECDSA P-256)
> and sealed (ECDH P-256 + AES-256-GCM), but Cartero has **not** had an independent security
> review. Treat it as a research project: fine to explore and self-host, **not** yet for
> high-risk threat models. See [Security & limits](#security--limits).

## How it works (in one line)

Each person writes only to **their own outbox** (a repo), sealing every message to the
recipient(s); a conversation is the **merge of the participants' outboxes**. Attachments are
encrypted and content-addressed **outside** the event (in `blobs/`); the signed event carries only
the (sealed) descriptor. Order between parties is **causal** (`reply_to`) — there is no global
sequencer. The contract is specified in [`SPEC-F0.md`](SPEC-F0.md).

## Getting started

**Prerequisites:** Node.js **≥ 20** (for global WebCrypto), git, and a GitHub account + token with access to a repo you
own (your outbox). No `npm install` needed — there are no runtime dependencies beyond the
submodule.

```bash
# 1. clone WITH the submodule (postal lives in vendor/postal)
git clone --recursive <repo-url> cartero
cd cartero
#    (if you already cloned without --recursive:  git submodule update --init)

# 2. run the tests (offline, no network)
npm test

# 3. run the CLI — either directly:
node src/cli.js <command>
#    or install the `cartero` command globally:
npm link        # then just `cartero <command>`
```

The examples below use the `cartero` command (after `npm link`); `node src/cli.js` works
identically.

## CLI

```bash
# secrets via env
export GH_TOKEN=$(gh auth token)      # a GitHub token with write access to YOUR outbox repo
export CARTERO_PASS=<your-passphrase> # encrypts your identity at rest (~/.cartero)

cartero init <owner/repo> --name "Alice"            # create identity + outbox, print your URI
cartero contact add <uri | user@domain> bob         # resolve + verify a contact, save "bob"
cartero send bob "hi 👋" [--file ./doc.pdf]          # send a sealed DM (optional attachment)
cartero read bob [--save ./downloads]               # print the conversation (merge of both outboxes)
cartero watch bob                                   # poll every 3s + instant relay delivery
```

`CARTERO_HOME` selects a separate local state dir (handy for running several identities on one
machine). **The relay is opt-in / self-hosted by default:** with no relay set, delivery is
git-only (async, ~2–5 s). For instant delivery, run your own relay (see [`deploy/`](deploy/)) and
point at it with `--relay <url>` or `$CARTERO_RELAY`. The relay is an untrusted forwarder
(ciphertext; recipients gate every event), so it never needs your trust — but pointing at a
third party's relay still exposes routing metadata to them, hence the self-host default.

### Groups

```bash
cartero group create project bob carol   # create with your contacts; publishes a signed group doc
cartero group join <creator-uri> <group-id>
cartero group send project "hi all" [--file ...]
cartero group read project               # merge of every member's outbox
```

### Discovery — add someone by just their id (F4)

Share only your short id (`postal:A1B2C3D4E5F60718`) instead of a full URI. You publish a
**self-signed** `id → outbox` record to a registry; others resolve your id through it.

```bash
cartero register --registry <url>                  # publish your id -> outbox (or $CARTERO_REGISTRY)
cartero contact add <id> --registry <url>          # add a contact by their bare id
```

Only you can claim your own id (id = your key's fingerprint → **no squatting**), and resolvers
**re-verify every record locally**, so a malicious registry can't point you at the wrong outbox —
it can only refuse to serve (use another, or share your URI/handle directly). Like the relay, the
registry is **opt-in / self-hosted** (`--registry` / `$CARTERO_REGISTRY`); run your own from
[`deploy/`](deploy/).

### Domain handles (`user@domain`)

A readable, give-out-able address resolved WebFinger-style. `cartero init --handle alice@you.dev`
emits a **signed binding** to publish at `https://you.dev/.well-known/postal/alice.json`. Double
attestation: the domain serves it (TLS = domain control) and the key signs it. The identity stays
the key, so the handle is a portable, disposable alias. Others add you with
`cartero contact add alice@you.dev`.

### Multi-device

One identity authorizes several **devices**, each with its OWN key (the master signs a cert per
device). A device acts as the identity (`from` = the identity, signed by the device key); the gate
accepts a signature from any authorized key. Messages are sealed to **all** of a recipient's keys.

```bash
cartero device add phone --out phone.json   # on the device holding the master key: certify + publish
cartero device import phone.json            # on the new device (its own CARTERO_HOME): pair as you
```

## Web UI

A browser DM client: `node web/server.mjs` → http://localhost:8765. The browser does everything
(generates the identity, signs/seals, talks to GitHub with your token and to the relay); the
server only serves static files and holds no secrets. **Secrets are encrypted at rest:** your
identity (private key) and token live in a vault (PBKDF2 → AES-256-GCM with a passphrase you enter
each session); localStorage only ever holds the ciphertext.

## Tests

```bash
npm test                                                # core suites (no network)
GH_TOKEN=$(gh auth token) GH_OWNER=<o> GH_REPO_A=<a> GH_REPO_B=<b> \
  node test/integration.test.mjs                        # DM round-trip vs real repos
```

The offline suites (`cartero`, `handle`, `relay`, `group`, `device`, `multidevice`) cover the
protocol: sealed round-trips, the gate (forgery / impersonation / inject-charged ids rejected),
attachments (hash-verified), multi-outbox merge, and multi-device. Integration tests exercise the
real GitHub transport.

## Security & limits

Honest, by design:

- **Not audited.** See the warning above. The canonical-JSON used for signing is not yet pinned to
  a formal standard (JCS/RFC 8785), so cross-implementation interop isn't guaranteed yet.
- **Metadata is not hidden.** Content is sealed (E2EE), but the signed envelope exposes
  `from`/`to`, and a host with read access sees who talks to whom and when. Anonymous sealing hides
  recipients *inside* the envelope, not the event fields. Hiding the social graph needs more
  (per-conversation access control, mixnets) — out of scope.
- **Order is causal, not total.** Between independent repos there is no trusted sequencer;
  `created_at` is self-asserted and `reply_to` carries happened-before.
- **Multi-device:** the master manages devices (no per-device revocation list yet); messages
  sealed *before* a device is added are not readable by it (no retroactive access).
- **Availability vs sovereignty:** your repo must be reachable when peers read. Any commodity git
  host works (you can migrate freely because identity = your key), but a laptop behind NAT isn't a
  24/7 inbox — that's inherent to async messaging, not a Cartero limitation.

## Roadmap

`SPEC-F0` (contract) · F1 MVP (DMs, attachments, CLI) · F2 handles + relay · F3 groups +
multi-device + web UI · F4 **discovery registry** (`id → repo`) — **done & deployed**. Remaining
in F4 and beyond: a multi-repo aggregator (a federated timeline; per-conversation merge already
covers DM/group), pinning the canonical form (JCS/RFC 8785) for cross-implementation interop, and
an independent security review.

## License

[MIT](LICENSE).
