// Cartero F4 — the aggregator: a unified inbox across MANY repos. The CLI fans out reads to every
// contact's outbox and every group's members' outboxes, resolves each conversation with the
// existing resolvers, and this pure helper summarizes + orders them (latest activity first). No new
// protocol — it's a convenience view over the per-conversation merges.

// threads: [{ name, kind: "dm" | "group", messages: [{ from, text, at, mine, readable }] }]
// (messages already in causal order from resolveConversation / resolveGroup).
// Returns one summary per thread that has messages, most-recent-activity first.
export function summarizeInbox(threads) {
  return threads
    .map((t) => {
      const last = t.messages.length ? t.messages[t.messages.length - 1] : null;
      const unreadable = t.messages.filter((m) => !m.readable).length;
      return { name: t.name, kind: t.kind, count: t.messages.length, unreadable, last };
    })
    .filter((s) => s.last)                                  // skip conversations with no messages
    .sort((a, b) => (a.last.at < b.last.at ? 1 : a.last.at > b.last.at ? -1 : (a.name < b.name ? -1 : 1)));
}

// A short one-line preview of a message for the inbox list.
export function preview(m, max = 48) {
  if (!m) return "";
  if (!m.readable) return "🔒";
  const who = m.mine ? "you: " : "";
  const text = (m.text || "").replace(/\s+/g, " ").trim();
  const atts = (m.attachments && m.attachments.length) ? ` [📎×${m.attachments.length}]` : "";
  const body = (who + text);
  return (body.length > max ? body.slice(0, max - 1) + "…" : body) + atts;
}
