# MiniWolService

A standalone Wake-on-LAN and fixed Jamat launcher website for a trusted LAN. It works while the
desktop Jamat application is stopped. Node's HTTP, crypto and UDP libraries cover the whole service;
there are no runtime packages or V1 dependencies.

## Configuration and local run

Copy `config.example.json` to `config.json` and replace the example MAC addresses and broadcast.
Set `publicUrl` to this machine's LAN IPv4 address and an available port, then run:

```sh
node start.mjs config.json
```

Alternatively, `JAMAT_V3_WOL_CONFIG` contains the same JSON and takes precedence over the file.
Deployment keeps the real inventory in Docker Compose, outside the public source tree. Configuration
is read at startup; restart after changing it. Each computer gets a wake button. IDs must be unique,
lowercase names; MAC addresses use six colon-separated hex bytes. Existing inventories without
`launcher` remain valid and do not make PC HTTP requests.

The optional per-computer `launcher` object contains exactly `url` and `key`. The URL is the PC
launcher's HTTP IPv4 origin with no path, credentials, query or fragment. The key is 32 random bytes
written as 64 hexadecimal characters and must match the PC launcher configuration. Replace the
synthetic example key with a distinct random key for each PC, for example using
`node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`. Omit the entire
`launcher` object when that PC has no launcher. The URL and key are never included in its HTML or
request logs. The one-time setup below transfers them directly to Jamat on the configured PC.

`publicUrl` is the exact browser origin and the listening address. Open that address, including its
port. The service deliberately accepts only that Host and same-origin browser POSTs. It has no login and
is intended for trusted LAN users, with no public reverse proxy or Internet port forwarding. Any
user who can reach it can wake a configured PC and request its one configured Jamat instance.
Starting that instance grants no session, terminal or desktop access.

## Docker

Build with a fresh UTC build time, then provide configuration when starting the image:

```sh
docker build --build-arg BUILD_TIME=2026-09-30T12:00:00Z -t jamat-mini-wol-service:1.2.0 .
docker run --network host --read-only --cap-drop ALL --security-opt no-new-privileges \
  --env JAMAT_V3_WOL_CONFIG="$(cat config.json)" jamat-mini-wol-service:1.2.0
```

The timestamp is illustrative; generate it for each build. On Linux, host networking gives the
sender access to the LAN broadcast network. Do not add published ports with host networking.
The service runs as the unprivileged `node` user and needs no capabilities or persistent volume.

`GET /api/system/health` checks HTTP availability. `GET /api/system/version` returns `version` and
`buildTime`; Docker also stores the build time in `APP_BUILD_TIME`.

## Wake behavior

Each form posts to `/wake/<configured-id>`. The server sends one 102-byte magic packet to the
configured IPv4 broadcast address on UDP port 9, then redirects to the result page. No arbitrary
MAC, destination or command can be submitted. The page confirms packet submission only: it cannot
confirm that firmware accepted it, Windows resumed or Jamat started. Wake-on-LAN must already be
enabled on the target's firmware/network adapter.

## Fixed Jamat startup

For a PC with `launcher`, the page also shows its current Jamat state and a `Spustit Jamat` form
posting to `/start/<configured-id>`. There is no profile, variant, executable, argument or command
field. The PC launcher owns its one fixed target. In the intended two-PC setup, Luda starts the
packaged `luda-dev` instance with automatic rebuild when needed, while IVA starts the installed
GitHub release EXE. Those targets are configured on their PCs, never in a browser request.

The PC launcher must already run in the signed-in Windows user's session and be reachable from
the Docker host. A sleeping PC shows an unavailable launcher. Wake it first, then use `Obnovit stav`
and `Spustit Jamat`. Wake and start are separate actions. The page checks all configured launchers
in parallel on each load, with a three-second total timeout per request. WoL POSTs and service
health do not query or wait for the launcher. Concurrent status or start requests share one PC
request per configured launcher and action. Success and failure are cached for one second after
the request settles. A fresh start invalidates the status cache when it begins and ends, so a
page refresh can see its new state. This bounds signed probes during repeated page requests.
There is no polling or browser JavaScript.

The private server-to-PC protocol is:

- `GET /api/status`, empty body, HTTP 200 with a `state` field containing one of `ready`, `stopped`,
  `starting` or `failed`.
- `POST /api/start`, empty body, HTTP 200 with `state: "ready"` when already ready, or HTTP 202 with
  `state: "starting"` after accepting the request. Subsequent status requests report its outcome.
- JSON may also contain an `error` string; other fields and states are rejected. PC diagnostics are
  not reflected into HTML. The page shows fixed Czech failure messages.
- `X-Jamat-Timestamp` is `Date.now()` in decimal, `X-Jamat-Nonce` is 16 random bytes in hexadecimal,
  and `X-Jamat-Signature` is HMAC-SHA256 in hexadecimal. The HMAC key is decoded from hex and the
  signed UTF-8 text is `METHOD + '\n' + pathname + '\n' + timestamp + '\n' + nonce`.

The PC agent checks its exact Host, rejects Origin headers, timestamps outside 30 seconds and
replayed nonces. MiniWolService sends no Origin header and follows no redirects. Replies must be
uncompressed `application/json` (optionally `charset=utf-8`), at most 16 KiB, with the exact shape
and status/state combination above. Offline, authentication and malformed-reply failures leave
the wake action available. Browser POSTs retain exact same-origin, Host and empty-body checks;
CSP disallows scripts and embedding.

## Set up Autolauncher from Jamat

For a configured launcher, press **Nastavit spouštění Jamatu** on the web page. On that PC, open
Jamat's **Settings → Autolauncher**, paste the displayed invitation and confirm installation for
the current profile. No launcher key, JSON or configuration file needs to be copied. This works
before the PC launcher is installed or reachable.

The third native form sends an empty `POST /setup/<configured-id>` with the service's exact Origin.
The returned HTML contains instructions and a read-only text area with a copyable URL:
`http://<service-ip>:<port>/#autolauncher=<64-lowercase-hex-characters>`. Its fragment is 32 random bytes;
the launcher address and key are absent. The URL is intended for the Settings field. Opening it in
a browser shows the ordinary page and does not redeem it. A new invitation replaces the previous
one for that PC. Invitations expire after five minutes, are single-use and disappear on restart.

Jamat redeems it with `POST /api/launcher-pair` and JSON `{ "token": "<invitation-token>" }`. The request
must use the exact configured Host, carry no Origin or Content-Encoding and have `application/json`
content (optional UTF-8 charset). Both declared and streamed body sizes are limited to 1 KiB. At most
16 bodies are read concurrently, each with a three-second deadline. The service keeps at most one
invitation per configured PC and removes expired entries whenever an invitation is issued or used.

Redemption requires the TCP socket's source IPv4 address to equal the configured launcher's IPv4
address; IPv4-mapped IPv6 addresses are normalized. Forwarded headers are ignored. Wrong source,
unknown token, expiry and replay receive the same denial. A wrong-source attempt leaves a valid
invitation available to its PC. Validation and consumption happen together, so concurrent uses
cannot disclose the configuration more than once. An accepted response is `application/json` with
exactly `publicUrl` (the existing launcher URL), `key` (its existing key) and `gatewayAddress` (the
service's configured bind/public IPv4). All responses are `Cache-Control: no-store`. There are no
redirects, caller-supplied targets or general inventory/configuration API.

This bootstrap trusts the LAN and the target PC. It requires an explicit web action and a local
Settings action; the source-IP check is not user authentication. Plain HTTP does not protect the
invitation or response from LAN traffic interception. Redeem directly from the PC on the configured
LAN address, without a proxy or NAT changing that source. Existing HMAC authentication remains in
place for subsequent gateway-to-launcher status and start requests.

## Checks

Run `node --test *.test.mjs`. The integration test starts real HTTP and UDP listeners and
verifies the packet received on loopback port 9, target selection, rejected requests, HTML escaping
and version metadata. A real HTTP fake PC agent verifies request signatures, fresh nonces, empty
bodies and fixed endpoints. Tests cover start/status states, key privacy, rejected web requests,
invalid and oversized PC responses, no redirects, wrong keys, parallel deadlines, concurrent request
coalescing, failed-request retry after cache expiry and wake/health availability while PC requests
stall. Pairing tests cover matching and wrong source PCs, forwarded-header spoofing, IPv4-mapped
addresses, expiry, replacement, replay, concurrent redemption, Host/Origin/body/content checks,
streamed size limits, bounded slow readers and HTML without keys. Tests never use the deployment
inventory. UDP port 9 must be free on the test
machine; on Linux a test runner may need permission to bind a low port. The root `pnpm test` and
`pnpm typecheck` include this package.
