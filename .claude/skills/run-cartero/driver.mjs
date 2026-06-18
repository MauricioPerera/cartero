#!/usr/bin/env node
// Cartero run-skill driver — an OFFLINE smoke that proves the protocol core, the bot runtime,
// and the CLI work on this machine. No network, no GitHub token, no secrets.
//
//   node .claude/skills/run-cartero/driver.mjs
//
// Exits non-zero if any check fails. This is the layer most cartero PRs touch (src/*.js,
// vendor/postal/src/*.js) — drive it here without spinning up the full git transport.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const imp = (rel) => import(pathToFileURL(join(ROOT, rel)).href);
const isWin = process.platform === "win32";

let failed = 0;
async function check(label, fn) {
  process.stdout.write(`• ${label} ... `);
  try { await fn(); console.log("ok"); }
  catch (e) { failed++; console.log("FAIL\n    " + String(e && e.message || e).split("\n")[0]); }
}

// 1. Node >= 20 (cartero needs global WebCrypto, only stable from Node 20).
await check("node >= 20 (global WebCrypto)", () => {
  const maj = Number(process.versions.node.split(".")[0]);
  if (maj < 20) throw new Error(`need node >= 20, have ${process.versions.node}`);
});

// 2. The offline gate: run the project's own suites (the `npm test` set) directly with node —
//    no npm/shell, so it's clean and cross-platform. Each suite exits non-zero on any failure.
await check("offline gate is green (all test suites)", async () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const suites = [...String(pkg.scripts.test).matchAll(/test\/[\w.-]+\.mjs/g)].map((m) => m[0]);
  if (!suites.length) throw new Error("no suites found in package.json scripts.test");
  let passed = 0;
  for (const s of suites) {
    let out = "";
    try { out = execFileSync("node", [s], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
    catch (e) { throw new Error(`${s} failed: ${String(e.stdout || e.stderr || e.message).split("\n").filter((l) => /FAIL/.test(l))[0] || "non-zero exit"}`); }
    passed += [...out.matchAll(/(\d+) passed/g)].reduce((a, m) => a + Number(m[1]), 0);
  }
  if (passed < 100) throw new Error(`only ${passed} checks passed (expected 100+)`);
});

// 3. The CLI binary runs and prints usage on no args (exits non-zero).
await check("CLI prints usage on no args", () => {
  let code = 0, text = "";
  try { execFileSync("node", ["src/cli.js"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e) { code = e.status; text = String(e.stderr || "") + String(e.stdout || ""); }
  if (code === 0) throw new Error("expected a non-zero exit");
  if (!/commands:/.test(text)) throw new Error("expected usage text with 'commands:'");
});

// 4. Real protocol round-trip in memory: seal a DM, recipient reads it, outsider cannot, gate accepts.
await check("sealed DM round-trip + gate (in memory, no network)", async () => {
  const { createIdentity, publicIdentityDoc } = await imp("vendor/postal/src/postal.js");
  const { buildDm, openDm, verifyDm } = await imp("src/convo.js");
  const alice = await createIdentity("Alice");
  const bob = await createIdentity("Bob");
  const eve = await createIdentity("Eve");
  const directory = {
    [alice.id]: await publicIdentityDoc(alice),
    [bob.id]: await publicIdentityDoc(bob),
  };
  const ev = await buildDm(alice, bob.id, { text: "hola 👋", reply_to: null, attachments: [] },
    { created_at: "2026-06-18T12:00:00.000Z", rnd: "drv1", seq: 0, prev: null, directory });
  if (!(await verifyDm(ev, { directory })).ok) throw new Error("gate rejected a valid DM");
  if ((await openDm(ev, bob)).text !== "hola 👋") throw new Error("recipient could not read the DM");
  let eveRead = false; try { await openDm(ev, eve); eveRead = true; } catch {}
  if (eveRead) throw new Error("an outsider could read the sealed DM");
});

// 5. The bot runtime: an echo-bot tick over in-memory outboxes answers a message exactly once.
await check("bot runtime echoes once (in memory)", async () => {
  const { createIdentity, publicIdentityDoc, eventHash } = await imp("vendor/postal/src/postal.js");
  const { outbox, eventPath } = await imp("src/outbox.js");
  const { buildDm, deriveChatId } = await imp("src/convo.js");
  const { createBot } = await imp("src/bot.js");
  function memClient() {
    const s = new Map();
    return {
      async putFile(p, c) { s.set(p, c); },
      async getFile(p) { return s.has(p) ? { content: s.get(p) } : null; },
      async commitFiles(fs) { for (const f of fs) s.set(f.path, f.content); },
      async listTree(pre) { return [...s.keys()].filter((k) => k.indexOf(pre) === 0).sort(); },
    };
  }
  const human = await createIdentity("Human"), echo = await createIdentity("Echo");
  const hOut = outbox({ host: "github.com", owner: "h", repo: "in", client: memClient() });
  const eOut = outbox({ host: "github.com", owner: "e", repo: "in", client: memClient() });
  await hOut.publishIdentity(await publicIdentityDoc(human));
  await eOut.publishIdentity(await publicIdentityDoc(echo));
  const dir = { [human.id]: await publicIdentityDoc(human), [echo.id]: await publicIdentityDoc(echo) };
  const chat = await deriveChatId(human.id, echo.id);
  const m = await buildDm(human, echo.id, { text: "ping", reply_to: null, attachments: [] },
    { created_at: "2026-06-18T12:00:00.000Z", rnd: "h1", seq: 0, prev: null, directory: dir });
  await hOut.appendEvent({ path: eventPath(chat, m), event: m });
  let cursor = {};
  const bot = await createBot({
    identity: echo, cfg: { host: "github.com", owner: "e", repo: "in" }, selfOutbox: eOut,
    peerOutbox: () => hOut, contacts: { human: { id: human.id, uri: `postal://github.com/h/in#${human.id}` } },
    cursorStore: { async load() { return cursor; }, async save(o) { cursor = o; } },
  });
  bot.onMessage(async (msg, ctx) => { if (msg.readable) await ctx.reply("echo: " + msg.text); });
  await bot.start({ once: true });
  await bot.start({ once: true }); // idempotent: must NOT answer twice
  const replies = (await eOut.readChat(chat)).filter((it) => it.event.from === echo.id);
  if (replies.length !== 1) throw new Error(`expected exactly 1 echo, got ${replies.length}`);
});

console.log(failed ? `\n✗ ${failed} check(s) failed` : "\n✓ all checks passed");
process.exit(failed ? 1 : 0);
