---
name: run-cartero
description: Build, run, smoke-test, and drive Cartero — the sovereign E2EE messenger over git (CLI + web UI). Use when asked to run, start, build, test, screenshot, or verify cartero, its CLI, its bot runtime, or its web UI.
---

# Run Cartero

Cartero is a sovereign, end-to-end-encrypted messenger that runs on git (identity = a key,
mailbox = a git repo). It has **two surfaces**: a CLI (`node src/cli.js …`) and a static **web UI**
(`node web/server.mjs` → http://localhost:8765). Zero runtime dependencies; the protocol core lives
in the `postal` git submodule at `vendor/postal/`.

Most work (and most PRs — see the audit history in `src/convo.js`, `src/group.js`,
`vendor/postal/src/postal.js`) touches the **protocol modules**, not a running window. So the
primary harness is an **offline driver** that exercises the protocol, the bot runtime, and the CLI
with no network and no GitHub token. A separate script smokes the web server.

> Paths below are relative to the cartero project dir (the unit). The drivers live in
> `.claude/skills/run-cartero/`.

## Prerequisites

- **Node.js ≥ 20** (Cartero needs global WebCrypto; Node 18 fails). Verified here on Node 24.
- **git** — and the submodule must be present (`vendor/postal/`).
- **No `npm install`** — there are no runtime deps.
- The web smoke uses **bash + curl** (Git Bash on Windows, native on Linux).

```bash
# If you cloned without --recursive, the protocol core (vendor/postal) is empty — fetch it:
git submodule update --init
```

## Run — agent path (offline, no token): the driver

This is the check to run first. It asserts Node ≥ 20, runs the full offline test suite, exercises
the CLI binary, and does a real in-memory sealed-DM round-trip + a one-tick echo-bot — all with no
network.

```bash
node .claude/skills/run-cartero/driver.mjs
```

Expected (exit 0):

```
• node >= 20 (global WebCrypto) ... ok
• offline gate is green (all test suites) ... ok
• CLI prints usage on no args ... ok
• sealed DM round-trip + gate (in memory, no network) ... ok
• bot runtime echoes once (in memory) ... ok

✓ all checks passed
```

### Direct invocation (the layer PRs touch)

The driver imports the public modules directly — copy its pattern to poke one function. The core
entry points: `vendor/postal/src/postal.js` (`createIdentity`, `publicIdentityDoc`, the gate),
`src/convo.js` (`buildDm`/`openDm`/`verifyDm`/`deriveChatId`), `src/bot.js` (`createBot`),
`src/outbox.js` (`outbox`, `eventPath`). `outbox({ client })` accepts an injected in-memory client,
which is how the driver (and the test suites) run the full flow without git.

## Run — web UI

Smoke the static server (launches it, checks it serves the UI + the ESM modules the browser imports,
checks the path-traversal guard, stops it):

```bash
bash .claude/skills/run-cartero/web-smoke.sh
```

Expected (exit 0):

```
cartero web UI on http://localhost:8765
ok  - serves the UI (<title>Cartero</title>)
ok  - serves /src/convo.js (200)
ok  - serves /vendor/postal/src/crypto.js (200)
ok  - path-traversal blocked (403)
✓ web smoke passed
```

For a **visual** check, run the server and screenshot it. On this box the browser harness is the
Claude Preview MCP (`preview_start` `node web/server.mjs` → `preview_screenshot`); on a headless
Linux box use `chromium-cli` against http://localhost:8765 — it's plain static HTTP, no build step.
The first screen is the encrypted-identity unlock (passphrase → "Abrir"); the browser does all the
crypto, the server holds no secrets.

## Run — human path (live, needs a GitHub token)

The CLI talks to a real GitHub repo (your outbox). Needs a token with write access + a passphrase:

```bash
export GH_TOKEN=$(gh auth token)        # write access to YOUR outbox repo
export CARTERO_PASS=<your-passphrase>   # encrypts your identity at rest (~/.cartero)
node src/cli.js init <owner/repo> --name "Alice"     # create identity + outbox
node src/cli.js contact add <uri|user@domain> bob    # add a contact
node src/cli.js send bob "hi 👋"                      # send a sealed DM
node src/cli.js read bob                              # read the conversation
```

A live echo-bot example (separate identity, its own `CARTERO_HOME` + token + outbox repo):

```bash
CARTERO_HOME=~/.cartero-agent CARTERO_PASS=… GH_TOKEN=$(gh auth token) node examples/echo-bot.mjs
```

## Gotchas (battle scars)

- **Submodule, not a copy.** `vendor/postal/` is a git submodule. A fresh `git clone` without
  `--recursive` leaves it empty and every import fails — run `git submodule update --init`.
- **Node ≥ 20 is hard.** Global `crypto` isn't available before Node 20, so the whole protocol
  throws on Node 18. The driver checks this first.
- **Windows Git Bash mangles leading-slash CLI args.** `node src/cli.js … "/ping"` becomes
  `C:/Program Files/Git/ping` (MSYS path conversion). Prefix the command with `MSYS_NO_PATHCONV=1`
  or use `//ping`. (Hit while driving the bot's `/ping` command.)
- **You can't `execFileSync("npm.cmd", …)` on Windows** — it fails with `EINVAL`. That's why the
  driver runs the test suites with `node` directly instead of `npm test`.
- **CLI needs real secrets.** `init`/`send`/`read` require `GH_TOKEN` (write to your outbox) and
  `CARTERO_PASS`. The offline driver deliberately avoids both — use it for verification in CI.
- **Two identities, one machine** → give each its own `CARTERO_HOME` (the live bot example does).

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Cannot find module '…/vendor/postal/src/…'` | Submodule not checked out → `git submodule update --init`. |
| Protocol throws on `crypto`/`subtle` | Node < 20 → upgrade to Node ≥ 20. |
| `set CARTERO_PASS` / `no identity — run cartero init` | Export `CARTERO_PASS` (and run `init`) before CLI commands. |
| Web server `EADDRINUSE` on 8765 | Another instance is up → `PORT=8780 bash .claude/skills/run-cartero/web-smoke.sh`. |
| Driver's CLI check fails | Run `node src/cli.js` by hand — it should print `commands: …` on stderr and exit non-zero. |
