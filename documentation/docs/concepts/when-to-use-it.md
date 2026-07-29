---
id: when-to-use-it
title: When Foreman pays for itself
sidebar_label: When to use it
description: The dividing line is context accumulation and coordination risk, not repository size.
---

# When Foreman pays for itself

Use Foreman when any of these are true:

- the work spans multiple phases, sessions, or context windows
- architecture and implementation need a durable connection
- multiple models or worker tiers participate
- smaller workers need bounded tasks and stronger supervision
- review findings and failed attempts must survive handoff
- implementation needs to be checked against more than a test exit code
- future-you or another developer must be able to inspect how "done" was reached

The dividing line is context accumulation and coordination risk, not repository size. A difficult single feature can justify the harness; a large mechanical rename might not.

## When to skip it

Skip Foreman when the task is a one-file fix that will finish in one clean session, a throwaway prototype, or work whose history and acceptance evidence have no future value. The protocols add real overhead: procedure context, state calls, review, and phase checkpoints. Do not pay that cost where a focused edit and a test run are enough.

The phased implementor also assumes a strong pitboss. A very small model should not own architecture, cross-unit integration, or security acceptance merely because it is cheap. Use small models in bounded worker seats.
