// Minimal Cartero bot: echoes back whatever a contact sends, and answers /ping.
//
// Run it as the AGENT identity (its OWN home, OWN outbox repo, OWN token):
//
//   CARTERO_HOME=~/.cartero-agent cartero init <you>/agent-inbox --name "Echo" --handle echo@you.dev
//   CARTERO_HOME=~/.cartero-agent cartero contact add <your-uri-or-handle> owner
//   CARTERO_HOME=~/.cartero-agent CARTERO_PASS=... GH_TOKEN=$(gh auth token) \
//     node examples/echo-bot.mjs
//
// Then, as yourself:  cartero contact add echo@you.dev echo  &&  cartero send echo "hola"
// Set CARTERO_RELAY on both sides (or pass relay below) for instant delivery; otherwise ~2-5s.

import { createBot } from "../src/bot.js";

const bot = await createBot({
  pass: process.env.CARTERO_PASS,
  token: process.env.GH_TOKEN,
  relay: process.env.CARTERO_RELAY || null,
});

bot.command("/ping", async (_msg, ctx) => { await ctx.reply("pong"); });

bot.onMessage(async (msg, ctx) => {
  if (!msg.readable) return;                       // 🔒 sealed to someone else — ignore
  console.log(`← ${ctx.contact}: ${msg.text}`);
  await ctx.reply(`echo: ${msg.text}`);
  console.log(`→ ${ctx.contact}: echo: ${msg.text}`);
});

console.log(`echo-bot running as ${bot.id}` + (process.env.ONCE ? " (single tick)" : " — Ctrl-C to stop"));
await bot.start({ intervalMs: 3000, once: !!process.env.ONCE });
if (process.env.ONCE) process.exit(0);
