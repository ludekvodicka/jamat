# Remote control & the AI bridge

Jamat can reach the Claude Code sessions running on your **other machines** over the LAN — take over
a session, hand a task to a remote agent, or let one AI agent drive another's tab. This is the
feature with remote-execution reach, so read the security notes before enabling it.

> **Off by default.** Remote control and the bridge are **disabled** and **loopback-only** until you
> explicitly opt in. Only enable LAN control on networks you trust. Full threat model:
> [architecture/security-model.md](architecture/security-model.md).

## The two listeners

Each machine's control surface binds at most two listeners:

| Listener | Address | When | Who it serves |
|---|---|---|---|
| **Local** | `127.0.0.1` | **always on** | this machine's own AI / CLI (full local power) |
| **LAN** | `0.0.0.0` | only when **enabled** *and* a machine key is set | peers on your network |

The local listener never leaves the machine, so the always-on convenience carries no network risk.
The LAN listener stays dark until you turn it on.

## Enabling LAN control

1. In the desktop app, enable remote control (it starts disabled).
2. Jamat generates this machine's **machine key** on first need and stores it outside the repo (in
   the app's user-data dir). The key is the bearer token every remote action must present.
3. Share the key with the peers you want to grant access; add each machine to the other side's peer
   list (host + key).

Every LAN request passes the full gate: **enabled → Origin/Host allow-list → bearer-key match**,
plus per-IP rate limiting. Remote file access is **path-scoped**, and **every remote action is
audit-logged**.

## The bridge — handing work to another agent

The bridge lets one agent (or you) hand a task to another machine's agent — or to **this** machine's
own app — and await its answer. It is driven by the `jamat` CLI, which talks only to **this**
machine's local gateway; the gateway proxies to peers (or to self), holds the credentials, and logs
everything.

Scenarios:

| Scenario | What it does |
|---|---|
| `terminal-task` | Open a tab on the target and run a task in it. |
| `consult` | Ask the target's agent a question, get its answer back. |
| `issue-handoff` | Point the target at an issue in your tracker; it does the work and reports back. |
| `notify` | Drop a message into a target session. |
| `unblock` | Nudge a session that is waiting on input. |

The bridge is **forge-agnostic** — `issue-handoff` only injects a prompt; the target agent uses its
own issue-tracker skill to do the actual work. The protocol stamps an `X-Jamat` header and frames
answers with explicit markers so the gateway knows where a reply begins and ends.

> **The remote's answer is untrusted.** Treat anything the bridge returns as input from another
> machine — review it before acting on it.

## Wake-on-LAN (optional)

To reach a machine that is asleep, run the standalone `app-wol` proxy on an always-on device on the
same LAN and point your peer config at it (`WOL_PROXY_URL`). Without it, Wake-on-LAN is simply off.

## Mobile

The `app-agent` server ships a small web app that can wake your PC (via the WoL proxy) and launch a
session, which you then drive through Claude Code's own interface in the browser.
