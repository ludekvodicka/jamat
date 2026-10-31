# Jamat mobile relay

Build the Linux amd64 image from the repository root with Docker BuildKit:

```sh
docker build -f app-relay/Dockerfile --build-arg BUILD_TIME=2026-10-30T21:00:00Z -t jamat-relay:1.5.1 .
```

Generate a fresh UTC build time for each image. The default build uses a digest-pinned public
Node 24.22.1 Debian image, refreshes OS packages and CA certificates, and selects the system CA
store. The runtime runs as `node` and contains no npm or npx.

The image contains an empty PC registry. Mount your registry read-only at
`/config/config-remote.json`, or select a registry inside the build context with
`--build-arg RELAY_CONFIG=app-relay/.private/config-remote.json`. Keep private registries outside
public source control. The Docker context permits that exact private path, not arbitrary files.

Set `JAMAT_V3_RELAY_ORIGIN` to the public HTTPS origin and configure
`JAMAT_V3_RELAY_AUTH_USER` and `JAMAT_V3_RELAY_AUTH_PASSWORD` (at least 32 characters).
`JAMAT_V3_RELAY_PORT` defaults to 8080. Optional Google login requires both
`JAMAT_V3_RELAY_GOOGLE_CLIENT_ID` and `JAMAT_V3_RELAY_GOOGLE_CLIENT_SECRET`, plus a comma-separated
`JAMAT_V3_RELAY_ALLOWED_EMAILS` allowlist. Missing credentials stop startup.

Operators can supply a prepared Debian Node image with `--build-arg NODE_RUNTIME_IMAGE=<image>`.
It must provide Node 24.22.1 or later, npm for the build stage, the `node` user, patched OS packages,
CA certificates and the system CA environment (`NODE_OPTIONS=--use-openssl-ca`,
`SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt`, `SSL_CERT_DIR=/etc/ssl/certs`). BuildKit skips the
public runtime stage in this mode; both application stages use the selected image.

## Wake, startup and enrollment

Relay 1.5.1 provides the single UI for MiniWolService 2.0.1 and remains compatible with 2.0.0. Configure both
`JAMAT_V3_RELAY_MINIWOL_URL` (the literal HTTP IPv4 origin of MiniWol) and
`JAMAT_V3_RELAY_MINIWOL_API_KEY` (64 lowercase hex) in Compose. The key matches MiniWol's
`JAMAT_V3_WOL_API_KEY`. Neither configured means `not-configured`; one alone stops startup.
The relay keeps bridge networking and MiniWol keeps host networking. MiniWol's exact Host check
requires its configured LAN origin, not a Docker hostname alias.

The existing login and same-origin checks protect these no-store JSON routes for all allowed users:

| Method | Route | Purpose |
|---|---|---|
| GET | `/api/wake-service` | Service state/version and matching PC capabilities |
| GET | `/api/wake-service/<id>/launcher` | Launcher state |
| POST | `/api/wake-service/<id>/wake` | Wake packet submission |
| POST | `/api/wake-service/<id>/start` | Fixed-profile Jamat startup |
| POST | `/api/wake-service/<id>/invitation` | One-time setup invitation |

The relay registry supplies cards and IDs. Equal MiniWol IDs supply capabilities; an ID outside the
relay registry is 404. The old `/api/wol` proxy, `JAMAT_V3_RELAY_WOL_PROXY_URL`, MAC and broadcast
registry fields are removed. MiniWol never gives the relay launcher keys, PC IPs or launcher URLs.
The API key stays server-side. Existing peer/legacy PC connection data remains separate.

MiniWol failure never blocks login or session access. The client times out after 6 seconds,
refuses redirects, caps replies at 16 KiB and validates JSON. An old non-JSON API 404 becomes
`needs-update`; malformed replies become `protocol-error`. The footer shows availability/version
from inventory/version reads. A connected Jamat peer takes precedence over launcher state.

Launcher failures may carry one of five allowlisted codes: `target-missing`, `target-invalid`,
`launch-failed`, `readiness-timeout` or `profile-unavailable`. The menu shows Czech repair text
for these codes; unknown details are discarded. Updating both services enables the detailed
message while preserving compatibility with old state-only launcher responses.

Wake confirms packet submission only. Status polling runs every 3 seconds for up to 90 seconds
after wake or 180 seconds after start; actions are never automatically resent. A 401 redirects to
login without retrying the action. MiniWol rate-limits each PC to one wake per 3 seconds and one
invitation per 10 seconds, with whole-second `Retry-After`.

**Nastavit spouštění Jamatu** displays MiniWol's unchanged LAN invitation as read-only text with
Copy/countdown. It is never a link, log entry or request URL. A new issue cancels the previous
invitation; refresh loses the displayed URL. On the named PC directly on the home LAN, paste it
into Settings → Autolauncher. The desktop redeems it directly with MiniWol using the existing
keyless token/source-IP contract. Fixed bearer HTTP requests can be replayed; this is an accepted
risk of the same-host relay-to-MiniWol path.

Record and retain both live service images before an authorized update. Relay 1.5.1 and MiniWol
2.0.1 were deployed on 2026-10-30, relay first, with build time `2026-10-30T21:31:57Z`.
The relay image records it in both `APP_BUILD_TIME` and `JAMAT_V3_RELAY_BUILD_TIME`.
Either patch can roll back independently to the previous 1.5.0/2.0.0 pair; detailed launcher errors
then become generic. The original migration from the separate LAN UI required rolling both
services back together. See [deployment and rollback](../docs/architecture/mini-wol-service.md#deployment-and-rollback)
for release evidence and retained image names.
