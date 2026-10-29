# Jamat mobile relay

Build the Linux amd64 image from the repository root with Docker BuildKit:

```sh
docker build -f app-relay/Dockerfile --build-arg BUILD_TIME=2026-10-29T07:00:00Z -t jamat-relay:1.4.3 .
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
