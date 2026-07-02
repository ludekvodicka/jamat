# app-agent — REST agent + remote relay

Two pieces:

- **Agent server** (`agent-server.ts`) — runs **on each PC** next to the desktop app. Exposes a
  local REST API (launch sessions, status) the desktop/CLI and the relay talk to.
- **Remote relay** (`remote-server.ts`, the `:3500` proxy) — an **optional**, self-hosted service
  that serves a small **mobile web SPA** (`web/`) and proxies requests to your PCs' agent servers,
  so you can wake/launch/check sessions from a phone. The PC registry + per-PC machine keys live in
  `config-remote.json`.

This README covers **deploying the relay**. The agent server is launched per-PC by the app /
launchers.

## Deploy the relay (Docker)

Prereqs: Docker + an always-on host on the same LAN as your PCs.

```bash
cd app-agent
cp config-remote.example.json config-remote.json   # then edit: your PCs + each PC's machine token
```

```bash
cp docker-compose.example.yml docker-compose.yml   # generic self-host compose (mounts the config)
docker compose up -d                               # → http://<host>:3500
```

> The committed file is `docker-compose.example.yml`, not `docker-compose.yml`, **on purpose**: a
> deploy tool may prefer a real `docker-compose.yml`, so a committed one could hijack the deploy.
> Self-hosters rename the example to activate it.

`config-remote.json` schema (see `config-remote.example.json`):

```jsonc
{
  "server": { "port": 3500 },
  "pcs": [
    {
      "id": "pc1", "label": "My Desktop",
      "mac": "AA:BB:CC:DD:EE:FF",          // for Wake-on-LAN
      "ip": "192.168.1.10", "agentPort": 3501,
      "broadcast": "192.168.1.255",
      "token": "<that PC's machine key>"    // the agent's remote-control.json `token`
    }
  ]
}
```

## Security

- `config-remote.json` holds **machine keys = RCE credentials**. It is **git-ignored — never in the
  public repo** (it sits in `app-agent/` only because the `Dockerfile` `COPY`s it from the build
  context). It is baked into the image at build (our private registry); you can also mount it
  read-only at runtime to override. The server reads `REMOTE_CONFIG`
  (default `/config/config-remote.json`) > `--config` > the baked copy.
- The relay is a control surface for your machines — run it **only on a trusted LAN**, behind your
  own auth/reverse-proxy if exposed beyond it.

## Configuration

| Env | Default | Purpose |
|---|---|---|
| `REMOTE_CONFIG` | `/config/config-remote.json` (image) / `./config-remote.json` (local) | Path to the PC registry. `REMOTE_CONFIG` > `--config <path>` > default. |
| `PORT` | `config.server.port` (or `8080` in the image) | Listen port. The compose file sets `3500`. |

Run locally without Docker: `node --import tsx remote-server.ts --config ./config-remote.json`.
