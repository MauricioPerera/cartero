// Cartero F4 — inbox aggregator (src/inbox.js), pure. Run: node test/inbox.test.mjs
import { summarizeInbox, preview } from "../src/inbox.js";

let p = 0, f = 0;
const ok = (n, c) => { c ? (p++, console.log("  ok  -", n)) : (f++, console.error("  FAIL-", n)); };
const m = (at, text, opts = {}) => ({ at, text, from: "x", mine: opts.mine || false, readable: opts.readable !== false, attachments: opts.attachments || [] });

console.log("# summarizeInbox: latest per thread, ordered by recency");
const threads = [
  { name: "bob", kind: "dm", messages: [m("2026-06-18T10:00:00Z", "hola"), m("2026-06-18T10:05:00Z", "ok")] },
  { name: "project", kind: "group", messages: [m("2026-06-18T12:00:00Z", "arranco")] },
  { name: "carol", kind: "dm", messages: [m("2026-06-18T09:00:00Z", "buenas")] },
  { name: "empty", kind: "dm", messages: [] },
];
const s = summarizeInbox(threads);
ok("conversations with no messages are dropped", s.length === 3 && !s.some((x) => x.name === "empty"));
ok("ordered by most recent activity (project, bob, carol)", s.map((x) => x.name).join() === "project,bob,carol");
ok("each carries the latest message + count", s[1].name === "bob" && s[1].last.text === "ok" && s[1].count === 2);
ok("kind is preserved", s.find((x) => x.name === "project").kind === "group");

console.log("# unreadable count (e.g. sealed before a device was added)");
const mixed = summarizeInbox([{ name: "z", kind: "dm", messages: [m("2026-06-18T01:00:00Z", null, { readable: false }), m("2026-06-18T02:00:00Z", "hi")] }]);
ok("counts unreadable messages in the thread", mixed[0].unreadable === 1 && mixed[0].count === 2);

console.log("# preview line");
ok("readable own message: 'you: ...'", preview(m("t", "hola bob", { mine: true })) === "you: hola bob");
ok("unreadable -> lock", preview(m("t", null, { readable: false })) === "🔒");
ok("truncates long text", preview(m("t", "x".repeat(100)), 10).endsWith("…") && preview(m("t", "x".repeat(100)), 10).length <= 11);
ok("shows attachment marker", preview(m("t", "doc", { attachments: [{}, {}] })).includes("[📎×2]"));

console.log(`\n${p} passed, ${f} failed`);
if (f) process.exit(1);
