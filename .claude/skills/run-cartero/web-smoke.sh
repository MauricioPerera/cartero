#!/usr/bin/env bash
# Cartero web-UI smoke: launch the static server, confirm it serves the UI and the ESM modules
# the browser imports directly, check the path-traversal guard, then stop it. No browser needed —
# the server is plain static HTTP. Run from anywhere:  bash .claude/skills/run-cartero/web-smoke.sh
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PORT="${PORT:-8765}"

node "$ROOT/web/server.mjs" & SRV=$!
trap 'kill "$SRV" 2>/dev/null || true' EXIT

for _ in $(seq 1 20); do curl -sf "http://localhost:$PORT/" >/dev/null 2>&1 && break; sleep 0.3; done

fail=0
title=$(curl -s "http://localhost:$PORT/" | grep -o '<title>[^<]*</title>')
[ "$title" = "<title>Cartero</title>" ] && echo "ok  - serves the UI ($title)" || { echo "FAIL- title=$title"; fail=1; }
for p in src/convo.js vendor/postal/src/crypto.js; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$PORT/$p")
  [ "$code" = 200 ] && echo "ok  - serves /$p (200)" || { echo "FAIL- /$p -> $code"; fail=1; }
done
code=$(curl -s -o /dev/null -w '%{http_code}' --path-as-is "http://localhost:$PORT/..%2f..%2fpackage.json")
[ "$code" = 403 ] && echo "ok  - path-traversal blocked (403)" || { echo "FAIL- traversal -> $code"; fail=1; }

[ "$fail" = 0 ] && echo "✓ web smoke passed" || echo "✗ web smoke failed"
exit "$fail"
