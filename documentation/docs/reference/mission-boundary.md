---
id: mission-boundary
title: Mission boundary
sidebar_label: Mission boundary
description: What Foreman owns, what it delegates, and what is explicitly out of scope.
---

# Mission boundary

Foreman's product is the controlled software-development loop:

```text
design -> spec -> bounded work -> delegated execution
       -> verification -> review -> gated completion -> resume
```

Foreman owns protocol delivery, canonical run state, delegation evidence, acceptance gates, and recovery. Worker engines and host-native agents own bounded code generation. For patch-returning backends, the host owns final patch application. Repository tooling and CI own their respective checks.

Model training, model serving, generic experiment tracking, prompt optimization, and automatic production routing are outside Foreman's mission. Evaluation may qualify a worker configuration, but an evaluation score never overrides tests, scope, security checks, or a Foreman gate.
