---
id: engineering-ethos
title: Security and quality are gated in, not scanned in
sidebar_label: Engineering ethos
description: The three pillars, the proportionality tier system, and why defects are rejected before commit rather than discovered after.
---

# Security and quality are gated in, not scanned in

Foreman bundles a canonical engineering-ethos document — served by the `ethos` tool and rendered with the active stack profile — that every protocol consumes. It defines three pillars (mechanical sympathy, security, contract-first observability) and a proportionality system: each major path declares a tier (`standard`, `hot`, `extreme`), and the tier determines how much rigor a change on that path must carry. Abstractions, controls, and telemetry are treated as costs to justify, and every justification is recorded.

## The security pillar operates at both ends of the lifecycle

- **Design time:** any component crossing a trust boundary requires a threat table — compromise impact, attacker techniques mapped to MITRE ATT&CK/ATLAS IDs, the specific controls, and the *named telemetry event* that would evidence exploitation. Detection is declared alongside the control, not bolted on later.
- **Review time:** every security finding carries a `[CWE-###]` classification before it can be recorded. Secrets appearing in a brief, log, span, or metric are an automatic CRITICAL. Dependency scans run at phase gates, and a new critical advisory fails the gate. Audit events are required to be a separate stream from operational logs.
- **Always:** security-versus-performance conflicts are recorded and arbitrated by the user — never silently resolved in either direction.

## Contract-first observability

The observability pillar is contract-first: the spec declares span names, metric names with bounded tag cardinality, and structured log schemas before implementation, so telemetry is reviewed against a contract instead of improvised per commit.

## Why this replaces discovery scanning

The practical consequence is that the defect classes downstream scanners hunt for — injection patterns, permission mistakes, leaked secrets, vulnerable dependencies — are being rejected at unit acceptance and phase gates, before commit. Code produced under the protocol tends to arrive at SAST/SCA already clean, and the scan becomes verification that the gates held rather than a discovery mechanism.

The boundary stated in [what Foreman enforces](./what-foreman-enforces.md#the-honest-boundary) still applies: gates cover the defect classes reviews and scanners can see; design-level assurance comes from the threat table, not the scanner.

## Stack profiles

The `FOREMAN_STACK_PROFILE` setting or `Docs/foreman-stack-profile.md` can supply repository-specific security-framework and telemetry-backend conventions without forking the core protocols.
