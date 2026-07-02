# Security Policy

Jamat can expose a **LAN control surface** — launching sessions, opening tabs, and injecting input
into a remote agent's terminal. That is real remote-execution reach, so we take security reports
seriously and ask you to disclose them responsibly.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately through **GitHub Private Vulnerability Reporting**:

1. Go to the repository's **Security** tab → **Report a vulnerability**.
2. Describe the issue, the impact, and steps to reproduce.

We aim to acknowledge a report within a few days and to keep you updated as we investigate and fix
it. Once a fix is released, we're happy to credit you (unless you prefer to stay anonymous).

## Scope

Especially interested in:

- Bypasses of the **machine-key / token gate** on the LAN control or agent endpoints.
- Ways to reach **closed-by-default** operations, or to escape the **path-scoped** remote file access.
- Remote input injection or tab control without authorization.
- Secrets leaking from configs, logs, the audit log, or build artifacts.

## Hardening notes for operators

- Remote control and the AI bridge are **off by default** and loopback-only until you opt in.
- Only enable LAN control on **networks you trust**; the control port is meant for a private LAN,
  not the public internet.
- Each machine generates its own key; treat machine keys like credentials.
- Review the audit log to see who (human or AI) controlled what.

## Supported versions

This is an actively developed, pre-1.0 project. Fixes land on the latest `main`; please reproduce
against a current build before reporting.
