# Internals

These pages are the detailed product contract for contributors and for coding agents working in this repository. They state boundaries precisely and are not a tutorial; start with the [user documentation](../README.md) instead.

DSH-SLOP, the Scientific Lab Operations Plugin, adds three independent capabilities to the upstream DSH Chat harness:

- **Machine** records compute machines, establishes protected SSH access, reuses connections, exposes a generic remote shell and Host-relayed file transfer, and stores approved Machine Info.
- **Knowledge** searches and maintains reusable Markdown in Home and the current official DSH Workspace.
- **Queue** records work that an Agent has already submitted, uses adaptive deterministic checks with narrow Agent fallback, and sends relevant changes only to the Chats that own or subscribe to them.

The product is Chat-first. Setup, authentication, discovery, Knowledge retrieval and writes, shell work, Queue tracking, status queries, and corrections occur through the normal Chat transcript and native DSH capabilities. One tabbed DSH-SLOP Settings section configures the Agent behavior preferences that apply to new sessions, Machines, Knowledge sources, Queue cadence, delivery, fallback, the fallback worker model and per-item overrides, and the optional callbacks; it is not a second Agent workflow.

The contract:

- [Shared vocabulary](../../CONTEXT.md)
- [Architecture](architecture.md)
- [Machine](machine.md)
- [Knowledge](knowledge.md)
- [Queue](queue.md)
- [Project work](project-work.md)
- [Standalone runtime and external configuration](runtime.md)
- [Status and known limits](../status.md)

Anything not described here is outside the product. In particular, DSH-SLOP does not own data analysis, result validation, Artifacts, general Workspace editing, scientific workflow execution, job submission, cancellation, retry, or a separate product persona. Knowledge may cite existing scripts, inputs, and results; their original files and native tools remain authoritative.
