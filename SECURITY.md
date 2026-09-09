# Security Policy

Jamat runs agent CLIs as real subprocesses on your machine and can expose a control surface that
starts sessions, types into a terminal and reads files. That is genuine remote-execution reach, so
security reports are taken seriously and we ask you to disclose them responsibly.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report it privately through **GitHub Private Vulnerability Reporting**:

1. Open the repository's **Security** tab, then **Report a vulnerability**.
2. Describe the problem, what an attacker gains, and how to reproduce it.

We aim to acknowledge a report within a few days and to keep you posted while it is investigated.
Once a fix ships we are happy to credit you, unless you would rather stay anonymous.

## What the attack surface actually is

Three listeners exist, and they are not equally exposed:

- **The Host** owns the terminals. It listens on loopback only, behind a bearer token written into a
  descriptor file that only your account can read. Nothing about it is reachable from the network.
- **The client's control endpoint** is what the `jamat-v3` command line client and the shipped agent
  skills talk to. It is loopback only and authenticated the same way.
- **The peer listener** is the one that can reach the network, and it is **off until you turn it
  on**. Its advertised address defaults to `127.0.0.1`, so even switching it on exposes nothing
  until you deliberately give it your LAN or VPN address. The application never touches firewall
  rules; the inbound rule is one you add by hand.

Between two paired computers the connection carries a signed handshake over each machine's long-term
Ed25519 identity, an ephemeral X25519 exchange, and AES-256-GCM frames with replay protection.
Pairing is explicit in both directions and pins the other machine's public key. Widening what
another computer may do asks you to confirm its name and key fingerprint; narrowing it asks nobody
and drops live connections immediately.

What a paired computer may ask for is a **closed allowlist**: status, projects, sessions, terminal
attach and input. Everything else is refused, including reading files, listing or opening tabs,
reading transcripts, and every pairing operation, which is what stops one paired machine from using
another as a relay to a third. Every accepted operation is audit-logged, and the log records no
token, no request body and no terminal text.

## Especially interested in

- Reaching the Host or the client's control endpoint without the token, or from off the machine.
- Getting a peer past the operation allowlist, or past the pairing check with an unpinned key.
- Breaking the handshake, the frame encryption, or the replay protection on the peer connection.
- Escaping the bounds on file access: reading a file the granting side did not open the door for.
- A secret reaching somewhere it should not: a log, an audit entry, a crash report, a descriptor
  file with loose permissions, or a build artifact.
- Turning content Jamat merely displays into execution: an agent's terminal output, a rendered
  document, a diff, or a reply from a paired computer.

## Notes for whoever runs it

- **Treat a peer's reply as untrusted input.** It is text another machine's agent produced; the
  application marks it that way, and so should you.
- **Only enable the peer listener on a network you trust.** It is meant for a LAN or a VPN, never
  for the public internet, and there is no relay or cloud rendezvous that would make that safe.
- **Your machine identity and pairing bundles are credentials.** A bundle carries a public key
  only, but the pairing it grants is a standing right; remove a computer you no longer use.
- **Agent credentials stay with the agent.** Jamat reads the token Claude Code already stored in
  order to show your rate limits, read-only; it never writes it, never uses the refresh token, and
  never proxies your traffic. Codex is asked through its own process.
- **Agents run without per-action prompts if you tell them to.** That is a setting, and it makes
  the folder you point a session at the blast radius. Choose accordingly.
- **Releases are unsigned.** Verify the `SHA256SUMS.txt` published with each release before running
  an installer.

## Supported versions

The project is developed on one line and fixes land in the next release. Please reproduce against
the current release, or against `main`, before reporting.
