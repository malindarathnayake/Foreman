---
id: privacy-and-security
title: Security
sidebar_label: Security
description: What repository data can leave the machine, through which tool, and what Foreman actually protects.
---

# Security

Foreman has no telemetry service of its own. Whether anything leaves your machine depends on which tools run and what you configured. The host model's own traffic never passes through Foreman.

## What leaves the machine

| Path | Data | Destination | On by default |
|---|---|---|---|
| The host model | Everything in the chat and every tool result | The host's provider | Yes, and Foreman cannot filter it |
| `invoke_advisor` | The review prompt: spec excerpts, diffs, file excerpts the model pasted | The Codex, Gemini, or Claude CLI, then that provider, with that CLI's login | When a CLI is installed and the procedure reviews a phase |
| `capability_check` | Nothing about the repo; runs the CLI's version and health commands | Local, then whatever the CLI's health command contacts | Same |
| `invoke_worker` | The brief and the full contents of the listed files | The endpoint in `.foremanenv` | No; needs `.foremanenv` |
| `aider_worker` | The brief and the files Aider reads | The model endpoint configured for that tier | No; needs `.foremanenv` and Aider |
| `invoke_council` | One evidence packet per seat: diffs, spec excerpts | The seats' endpoints | No; needs seat configuration |
| Langfuse tracing | Review metadata: seat, model, tokens, cost; prompt and finding text only when `FOREMAN_LANGFUSE_CONTENT` allows | Your Langfuse endpoint | No; needs the URL and keys |
| `preview_diagram` | A Mermaid diagram | A listener on `127.0.0.1` only | Only while a preview is open |

The ledger, progress, journal, and events files never leave the machine through Foreman. Whether they leave through git is your commit policy.

## Secrets

Foreman harvests secret values from the process environment at startup: a variable whose name matches a secret pattern, whose value is a single token of at least 8 characters and is not on a short denylist of dictionary words. It also registers the value behind `${ENV:NAME}` in `.foremanenv`. Those values are:

- replaced with `[REDACTED:env:NAME]` in the ledger, progress, journal, `PROGRESS.md` splice, and events file before every write;
- blocked from `invoke_worker` payloads; the call fails with `WORKER_PAYLOAD_SECRET_BLOCK` and nothing is sent;
- detected on the way back in, so a worker cannot echo a marker into a patch.

A secret that lives only in a file, and not in the environment, is not harvested and not scrubbed. Advisor CLIs are child processes and inherit the environment; Foreman does not strip it.

## `.foremanenv`

Must be ignored and untracked. `invoke_worker` and `aider_worker` both refuse to run otherwise, and say which condition failed. The file names the key's environment variable; it never holds the key.

## External worker protections

- **Base-file hashes.** Every patch or diff comes back with the hashes of the files it was computed against. The procedure makes the model compare them before applying and record `ED_STALE` when they differ.
- **Protected paths.** A patch that targets `.foreman-*` state, the docs directory, or a path outside the repo fails with `PATCH_PROTECTED_PATH_FAIL` before it is returned.
- **Redaction markers.** A patch containing a redaction marker fails with `PATCH_REDACTION_MARKER_FAIL`.
- **Payload and response caps.** Briefs, file payloads, and responses are size-bounded; over-cap calls fail before sending or discard the response.
- **Dirty tree.** `aider_worker` refuses untracked or modified delegated files and never runs `git stash`; the refusal tells you to commit or stash yourself.
- **Sidecar chain.** Every external delegation writes a hash-chained event log that the phase gate reconciles against the ledger. A chain that ends in failure blocks a pass verdict on that unit.

## Host-native workers

The host, not Foreman, runs those subagents. Foreman cannot stop one from running `git stash` or editing outside its files. The procedure gives every editing worker an explicit git-mutation denylist, snapshots repository state before the spawn, and makes the model compare after. Detection is after the fact. Keep normal commits and backups.

Report security issues through [SECURITY.md](https://github.com/malindarathnayake/Foreman/blob/main/SECURITY.md).
