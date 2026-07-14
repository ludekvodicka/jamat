# Security model & threat model

Jamat can expose a **LAN control surface**: one machine opening terminals, injecting keystrokes,
launching and updating software on another, and letting one AI agent drive another's tab. That is
remote-code-execution reach by design. This document is the threat model — what the surfaces are,
how they're gated, what is on by default, and what an operator must assume.

Audience: contributors and operators deciding whether/how to enable the networked features.
See `SECURITY.md` for how to report a vulnerability.

## TL;DR — closed by default

Out of the box, **nothing listens on the network.** A fresh install writes
`remote-control.json` with `enabled: false`; the LAN listener binds only when the user opts in
*and* a machine key exists. The op API is closed-by-default (each op must opt into who can reach
it). Wake-on-LAN and debug endpoints are separately gated and off unless configured.

## Components & attack surface

| Surface | Process / file | Binds | Default | Auth |
|---|---|---|---|---|
| **Control + gateway** | `app-electron` `op-server.ts` | loopback always (local CLI gateway); `0.0.0.0` (LAN) **only** when `enabled && key ≥ 32 hex` | LAN off | **LAN:** machine key (Bearer), timing-safe compare. **Loopback gateway:** loopback-trusted (Host/Origin-guarded, no key) — same stance as `/debug/*` |
| **Agent REST** | `app-agent` `agent-server.ts` | LAN, for the mobile web app | off unless `enabled` | same machine key (`checkControlAuth`) |
| **Remote relay proxy** | `app-agent` `remote-server.ts` | public-facing relay (optional) | not deployed by default | per-PC machine keys in `config-remote.json` |
| **Wake-on-LAN proxy** | `app-wol` | a small always-on box on the LAN | not run by default | none (magic-packet sender) — requires the target MAC |

The control surface is the primary concern; the relay + WoL proxy are optional infrastructure a
public user does not need.

## Authentication model

- **One machine key per machine.** Auto-generated (24 random bytes → 48 hex; minimum 32), stored in
  `<configDir>/remote-control.json` (with the rest of the config; each PC uses its own config-dir so
  the key stays per-machine). It gates the **LAN control surface** (and the agent REST). The **local
  loopback gateway is NOT key-gated** — it binds `127.0.0.1` only and is Host/Origin-guarded, so the
  `jamat` CLI reaches it without the key (a same-user local process can read the key file anyway; the
  meaningful boundary is the LAN port). The key is **never sent to a peer**.
- **Reaching a peer** uses *that peer's* key (configured in the peer row) — there is no separate
  per-peer "AI key". AI-origin is flagged to the controlled side with an `X-Jamat` marker for its
  audit log, **not** for auth.
- Compared **timing-safely** (both sides SHA-256-hashed to a fixed width before `timingSafeEqual`,
  so neither the value nor its length leaks).
- **No transport encryption** on the LAN control port. Confidentiality/integrity on the wire is the
  operator's responsibility (trusted LAN, or a VPN/SSH tunnel).

## Authorization — the op registry

The control surface is **not** a generic command dispatcher. Every capability is a **named op** in
a registry (`core/op/*`, `app-electron/src/main/ops/*`) carrying:

- **`reach`** — who may call it (`ui` = local human, `ai` = the bridge). Closed by default: an op
  not granting a reach is unreachable from that origin.
- **`rw`** — read-only vs mutating, so read-only audiences can't mutate.
- **`validate`** — argument validation before the handler runs.
- **`audit`** — whether the call is written to the activity log.

Remote **file** access is **path-scoped** — confined to configured roots, not arbitrary FS access.
RCE-adjacent endpoints (`/api/launch-app` — it launches code; `/api/update` — it can download and
install a new build) are **never** on an open CORS surface and always require the machine key.

## Auditability

Every controlled action — human or AI — is streamed to the **Remote Activity Log** tab on both
machines (it auto-opens). AI-origin actions are tagged. The log is the record of *who controlled
what*; review it after enabling LAN control.

## Untrusted remote output

Output read back from a peer (or a bridged AI) is surfaced as **`remoteOutputUntrusted`** and the
bridge answer markers are treated as data. Never auto-execute remote output: a compromised or
prompt-injected peer can return anything.

## Threats & mitigations

| Threat | Mitigation | Residual risk |
|---|---|---|
| Attacker on the LAN drives your terminals | LAN listener off by default; machine-key Bearer gate; closed-by-default ops | Key leak = full control → rotate the key; trusted-network assumption |
| RCE via launch/update endpoints | Auth-gated, not on open CORS, off until `enabled` | Same key compromise blast radius |
| Key theft from disk | Key lives in per-user `userData`, never committed, never sent to peers | Local malware with FS access can read it (OS-level trust boundary) |
| Wire sniffing / MITM on the LAN port | — (no TLS) | Real on an untrusted segment → tunnel it |
| Prompt-injected / malicious peer returns hostile output | Output is `remoteOutputUntrusted`; never auto-run | Human/AI must not blindly act on it |
| WoL abuse (power on / launch another machine) | Off unless MAC + proxy configured; "wake" is an explicit user command | Anyone who can reach the proxy can send magic packets |
| Secrets in configs / build artifacts | `*.local.json` + `config-remote.json` git-ignored; `dist/`/`out/` git-ignored & svn-ignored | Operators must not commit their own configs |

## Operator hardening checklist

- Keep Remote App Control **off** unless you need it; enable per-machine, deliberately.
- Only enable on a **trusted LAN**; tunnel (VPN/SSH) if it must cross an untrusted network.
- Treat the **machine key** as a credential — rotate it (regenerate in the app) on any suspicion.
- Don't expose the agent REST / relay proxy to the public internet without your own auth layer in
  front.
- Review the **Remote Activity Log** periodically.
- Never commit your `*.local.json` / `config-remote.json`.

## Defaults summary

| Setting | Default |
|---|---|
| Remote App Control (`enabled`) | `false` |
| LAN listener bound | only when `enabled && key ≥ 32 hex` |
| AI bridge / gateway | localhost-only; same key + `enabled` gate |
| Wake-on-LAN | off (needs MAC + proxy URL) |
| Debug endpoints | off (separate `APP_DEBUG_AI_TOKEN`) |
| Op registry | closed-by-default (per-op `reach`) |
| Remote file access | path-scoped to configured roots |
