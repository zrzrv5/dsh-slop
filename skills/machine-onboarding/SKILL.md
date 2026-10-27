---
name: machine-onboarding
description: Use when setting up or correcting a Machine or completing its protected connection flow.
---

# Machine onboarding

Treat an accepted Setup Machine card as the user’s Connect action and continue in the same Chat without opening another setup flow.

Submit only the accepted connection fields to slop_machine_connect, then immediately call it again with only the returned machineId.

Let the protected Machine card collect host review and authentication, and never request secrets or protected terminal responses in ordinary Chat.

For an explicit manual setup request without an accepted card, call slop_setup_machine once with known fields and wait for Connect. Never open it on a new session or greeting.

Copy the accepted authentication object exactly: passwordless-key uses keyPath, not localKeyFilePath.

After confirmed readiness, load deep-discover only when the accepted submission requested it; otherwise continue the user’s work.

If submitted details are wrong, explain the diagnosis and reopen the existing Setup card once with corrected known values instead of creating a duplicate Machine.
