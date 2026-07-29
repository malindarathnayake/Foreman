---
id: privacy-and-security
title: Privacy and security boundaries
sidebar_label: Privacy and security
description: What stays local, which processes reach the network, and the secret-handling rules.
---

# Privacy and security boundaries

Foreman's ledger, progress, journal, and metrics remain local. Foreman has no usage-telemetry service.

## Network and process boundaries

- `preview_diagram` is Foreman's only listener and binds to loopback
- `invoke_worker` sends the selected brief and file excerpts to the endpoint configured by the operator
- `invoke_advisor` launches the installed Claude, Codex, or Gemini CLI, which uses that provider's own network and authentication
- `aider_worker` launches the installed Python/Aider process and uses the endpoint configured for that worker tier
- the host model's own traffic never passes through Foreman and cannot be filtered by it

## Secrets

`.foremanenv` must be gitignored and untracked. Foreman refuses both configured worker paths otherwise. Known configured secrets are blocked from outbound worker payloads and scrubbed from Foreman-owned durable artifacts.

Read the full [security policy](https://github.com/malindarathnayake/Foreman/blob/main/SECURITY.md), including residual risks and reporting instructions, before enabling external worker endpoints.
