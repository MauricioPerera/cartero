# Deploy — cartero.ardf.dev (relay + handles)

The relay and the handle `.well-known` are served from one VPS behind Cloudflare.

## Components on the VPS (31.220.22.176)

- **Relay daemon** — `bin/relay-server.mjs` (imports `src/relay.js`), under pm2 as
  `cartero-relay`, bound to `127.0.0.1:8790` (HOST/PORT env). `pm2 save` persists it.
  Only `src/relay.js` is needed (no postal dep — pure `node:http`).
- **Handle bindings** — static JSON under `/var/www/cartero/well-known-postal/`, served
  at `/.well-known/postal/<user>.json` with `Access-Control-Allow-Origin: *`.
- **nginx vhost** — [`nginx-cartero.ardf.dev.conf`](nginx-cartero.ardf.dev.conf) at
  `/etc/nginx/sites-available/cartero.ardf.dev` (symlinked into `sites-enabled/`). Proxies
  `/sub` (SSE) + `/pub` to the relay; serves `/.well-known/postal/`. TLS terminates at
  Cloudflare; origin uses the `ardf.dev` apex cert (same pattern as the other vhosts).

## DNS (Cloudflare — done by the operator)

Add a **proxied** record: `cartero` → `31.220.22.176` (A, orange cloud), same as the other
`*.ardf.dev` subdomains. Until this exists, the endpoints are reachable only on the box.

## Redeploy the relay

```bash
# from a machine with the VPS MCP / ssh:
scp src/relay.js  root@vps:/root/cartero-relay/src/relay.js
scp bin/relay-server.mjs root@vps:/root/cartero-relay/bin/relay-server.mjs
ssh root@vps 'pm2 restart cartero-relay'
```

## Publish a handle binding

`cartero init <owner/repo> --handle <user>@cartero.ardf.dev --well-known out.json` emits the
signed doc; upload it to `/var/www/cartero/well-known-postal/<user>.json`.

## Verify (on the box, before DNS)

```bash
R="--resolve cartero.ardf.dev:443:127.0.0.1 -k -s"
curl $R https://cartero.ardf.dev/.well-known/postal/demo.json     # the binding JSON
curl $R -N https://cartero.ardf.dev/sub?chat=t &                  # SSE
curl $R -X POST https://cartero.ardf.dev/pub -d '{"chat":"t","event":{"x":1}}'  # -> the subscriber
```

## Honest notes

- The relay `/pub` is **open by design** (untrusted forwarder; recipients gate every event).
  A public relay should add a rate limit (nginx `limit_req`) to bound fan-out abuse — TODO.
- `demo.json` is a placeholder binding for infra testing (its key isn't a real user).
