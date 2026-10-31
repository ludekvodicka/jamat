# MiniWolService

MiniWolService 2.0.1 is a standalone Wake-on-LAN and fixed Jamat launcher API. The authenticated
Jamat relay owns the wake, start and invitation UI. MiniWol serves no HTML or CSS and works while
the desktop Jamat application is stopped. Node's HTTP, crypto and UDP libraries cover the service;
there are no runtime packages or V1 dependencies.

## Configuration and local run

Copy `config.example.json` to `config.json` and replace the synthetic MAC addresses and broadcast.
Set `publicUrl` to this machine's LAN IPv4 address and an available port. Set `JAMAT_V3_WOL_API_KEY`
to a distinct random key of exactly 64 lowercase hexadecimal characters, then run:

```sh
node start.mjs config.json
```

A missing or malformed API key prevents startup. Generate a key with
`node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"` and store it in the
service's Compose environment. The relay uses the same value in `JAMAT_V3_RELAY_MINIWOL_API_KEY`
and the MiniWol origin in `JAMAT_V3_RELAY_MINIWOL_URL`. These are server-side values.

`JAMAT_V3_WOL_CONFIG` contains the same JSON as the file and takes precedence. The API key stays
outside that JSON, so its schema and existing launcher pairings remain compatible. Real inventory
belongs in the deployment Compose file. Configuration is read at startup; recreate the container
after changing it. IDs must be unique lowercase names; MAC addresses use six colon-separated hex
bytes. Existing inventories without `launcher` remain valid and do not make PC HTTP requests.

The optional per-computer `launcher` contains exactly `url` and `key`. The URL is the PC launcher's
HTTP IPv4 origin with no path, credentials, query or fragment. Its key is 32 random bytes written
as 64 hex characters and matches that PC's launcher. Use a distinct key for each PC. Omit the entire
object for a wake-only PC. These values are returned only to the matching PC during enrollment.

`publicUrl` remains MiniWol's exact LAN origin and listening address, never the relay URL. All
requests require that exact single Host. MiniWol has no public reverse proxy or Internet port
forwarding. The access path is relay login, then the server-side API key, then MiniWol. Any LAN
caller possessing the key can invoke its actions. Plain HTTP and a fixed bearer key permit replay
of a captured request; that risk is accepted for the same-host relay-to-MiniWol deployment.

## API routes

Every `/api/v1/` request requires `Authorization: Bearer <64 lowercase hex>`, no Origin header,
an empty body and an exact path without query parameters. Missing, malformed and wrong keys all
receive `401 {"error":"unauthorized"}`; comparison is constant time. Every API v1 response is
no-store JSON.

| Method | Route | Success / action-specific errors |
|---|---|---|
| GET | `/api/v1/computers` | `200 {computers:[{id,label,hasLauncher}]}` |
| GET | `/api/v1/computers/<id>/launcher` | `200 {state}`; `409 no-launcher` |
| POST | `/api/v1/computers/<id>/wake` | `202 {sent:true}`; `429 rate-limited`; `502 wol-send-failed` |
| POST | `/api/v1/computers/<id>/start` | `202 {state:"starting"}` or `200 {state:"ready"}`; `409 no-launcher`; `502 launcher-unavailable` |
| POST | `/api/v1/computers/<id>/invitation` | `200 {invitationUrl,expiresInSeconds:300}`; `409 no-launcher`; `429 rate-limited` |
| GET | `/api/system/health` | Keyless `200 {ok:true}` |
| GET | `/api/system/version` | Keyless `200 {version,buildTime}` |
| POST | `/api/launcher-pair` | Keyless token/source-IP enrollment, unchanged below |

Launcher state is `ready`, `stopped`, `starting`, `failed` or `unavailable`. Every rejected launcher
status call becomes `unavailable`. API errors have exactly `{error:code}` with the closed codes
`unauthorized`, `forbidden`, `bad-request`, `not-found`, `method-not-allowed`, `unknown-computer`,
`no-launcher`, `rate-limited`, `wol-send-failed`, `launcher-unavailable`. Wrong Host is 421; Origin
is 403; request bodies are 400. Unknown paths/PCs are 404 and wrong methods are 405.

One computer may receive one wake per 3 seconds and one invitation per 10 seconds. A 429 includes
`Retry-After` in whole seconds. `GET /`, `GET /web.css` and the former `POST /wake/<id>`,
`/start/<id>`, `/setup/<id>` return `404 {"error":"not-found"}` without effects. No route returns
HTML. CSP is `default-src 'none'; frame-ancestors 'none'`.

## Docker

Build with a fresh UTC build time, then provide both configuration variables:

```sh
docker build --build-arg BUILD_TIME=2026-10-30T21:00:00Z -t jamat-mini-wol-service:2.0.1 .
docker run --network host --read-only --cap-drop ALL --security-opt no-new-privileges \
  --env JAMAT_V3_WOL_CONFIG="$(cat config.json)" --env JAMAT_V3_WOL_API_KEY \
  jamat-mini-wol-service:2.0.1
```

The timestamp is illustrative. Linux host networking gives the sender access to the LAN broadcast
network. Do not add published ports. The service runs as unprivileged `node` with no capabilities
or persistent volume. The relay remains on its bridge network and calls the literal MiniWol LAN
IPv4 origin, since another Host fails validation.

The default BuildKit build uses a digest-pinned public Node 24.22.1 Debian image, refreshes OS
packages and CA certificates, and selects the system CA store. A prepared Debian Node base can be
selected with `--build-arg NODE_RUNTIME_IMAGE=<image>`. It must provide `node`, patched packages,
CA certificates and `NODE_OPTIONS=--use-openssl-ca`, `SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt`,
`SSL_CERT_DIR=/etc/ssl/certs`. BuildKit then skips the public runtime stage.

Health remains keyless for Docker. Version reports `version` and `buildTime`; Docker also stores
the build time in `APP_BUILD_TIME`. Record and retain the live images before an authorized update.
Relay 1.5.1 and MiniWol 2.0.1 were deployed on 2026-10-30 with build time
`2026-10-30T21:31:57Z`, relay first. Both remain API-compatible with the previous 1.5.0/2.0.0 pair;
either patch can roll back independently, losing detailed launcher errors. The original migration
from the separate LAN UI required a coordinated rollback of both services. Release evidence and
retained image names are in [deployment and rollback](../docs/architecture/mini-wol-service.md#deployment-and-rollback).

## Wake behavior

The keyed wake route sends one 102-byte magic packet to the configured broadcast on UDP port 9.
The packet is six `ff` bytes followed by sixteen copies of the six-byte MAC. No caller can supply
an arbitrary MAC or destination. Acceptance confirms only OS packet submission, not firmware wake,
Windows resume or Jamat startup. The relay states this distinction. Wake-on-LAN must already be
enabled in the target's firmware and network adapter.

## Fixed Jamat startup

The relay shows launcher state and **Spustit Jamat** for matching configured PCs. There is no
profile, variant, executable, argument or command field. The PC launcher owns its fixed target.
It must run in the signed-in Windows user's session and be reachable from the Docker host.
Wake and start are separate actions. Each launcher call has a three-second deadline; concurrent
status or start requests share one call per launcher/action and cache success or failure for one
second. A fresh start invalidates the status cache at its beginning and end. Wake and health do not
wait for launcher calls.

The gateway-to-PC protocol remains:

- `GET /api/status`, empty body, 200 with `state: ready|stopped|starting|failed`.
- `POST /api/start`, empty body, 200 with `state:"ready"` or 202 with `state:"starting"`.
- For a failed target, optional `error` forwards only `target-missing`, `target-invalid`,
  `launch-failed`, `readiness-timeout` or `profile-unavailable`. Unknown text is discarded;
  paths, arguments and keys never reach the relay. Old state-only responses remain accepted.
- `X-Jamat-Timestamp` is decimal `Date.now()`, `X-Jamat-Nonce` is 16 random bytes in hex, and
  `X-Jamat-Signature` is HMAC-SHA256 hex over `METHOD + '\n' + pathname + '\n' + timestamp + '\n' + nonce`,
  with the launcher key decoded from hex.

The PC agent checks exact Host, no Origin, timestamps within 30 seconds and unused nonces.
MiniWol follows no redirects and accepts only uncompressed JSON, at most 16 KiB, with matching
status/state and valid UTF-8. Wake remains available when a launcher rejects or cannot be reached.

## Set up Autolauncher from Jamat

Sign in to the Jamat relay and select **Nastavit spouštění Jamatu** for the PC. The relay displays
the invitation as read-only text with Copy and a countdown. On that PC, directly on the home LAN,
open Jamat **Settings → Autolauncher**, paste it and confirm installation for the current profile.
An installed or reachable launcher is not required to issue an invitation.

MiniWol returns `http://<service-ip>:<port>/#autolauncher=<64-lowercase-hex-characters>` unchanged
through the relay. Its fragment is 32 random bytes. The relay never reconstructs the URL, links it,
logs it or places it in a request URL. Opening it in a browser now receives 404 and does not redeem
it. Each invitation lasts five minutes, is single-use and disappears on MiniWol restart. A new
invitation after the issuance cooldown invalidates the previous one for that PC. Refreshing the
relay page loses the displayed URL; the countdown cannot detect redemption or replacement.

The desktop still posts `{ "token": "<invitation-token>" }` directly to `/api/launcher-pair` without
the API key. Exact Host, no Origin or Content-Encoding, JSON with optional UTF-8 charset, a 1 KiB
body limit, 16 concurrent readers and a three-second reader deadline remain unchanged.

The TCP source IPv4 must equal the configured launcher IPv4; IPv4-mapped IPv6 is normalized and
forwarded headers are ignored. Wrong source, unknown token, expiry and replay share one denial.
A wrong source does not consume a valid invitation; synchronous consumption allows exactly one
concurrent redemption. The no-store JSON success has exactly `publicUrl` (launcher URL), `key`
(existing launcher key), and `gatewayAddress` (MiniWol bind/public IPv4). No redirects or arbitrary
targets are accepted. These launcher credentials never pass through the relay.

Enrollment trusts the LAN and the target PC; source IP does not identify its user. Plain HTTP does
not encrypt the invitation or response. A proxy or NAT changing the source cannot redeem it.
Existing launcher HMAC, configuration and installed pairings remain unchanged.

## Checks

Run `node --test service.test.mjs pairing.test.mjs`. Real loopback HTTP/UDP fixtures check exact
packet bytes, key authorization, inventory privacy, closed launcher states and failures, cooldowns,
coalescing, deadlines, removed paths without effects and version metadata. Pairing checks preserve
source matching, spoofed headers, IPv4 mapping, expiry, replacement, replay, concurrent redemption,
Host/Origin/target checks, body limits and bounded slow readers. Response helpers reject HTML.
Tests use synthetic inventory only. UDP port 9 must be available; Linux may require low-port bind
permission. Root `pnpm test` and `pnpm typecheck` include this package; relay gates are separate.
