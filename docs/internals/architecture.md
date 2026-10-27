# Architecture

## Product boundary

DSH-SLOP is an additive plugin layer over DSH. It does not replace the harness and does not create a parallel conversation, Agent lifecycle, shell, task system, Skill registry, or scheduler UI.

```text
upstream DSH Chat
  ├─ native Standard / Code Agent capabilities
  ├─ dsh-slop-machine
  │    ├─ Machine authority and Machine Info
  │    ├─ protected SSH / 2FA carrier
  │    ├─ reusable SSH connections
  │    ├─ generic remote shell
  │    └─ Host-relayed file transfer
  ├─ dsh-slop-knowledge
  │    ├─ Home and current Workspace Markdown
  │    ├─ bounded search and explicit read
  │    ├─ atomic write with create and update modes
  │    └─ rebuildable derived index
  └─ dsh-slop-queue
       ├─ local durable ledger
       ├─ adaptive walltime-aware checks
       ├─ deterministic scheduler/process probes
       ├─ narrow short-context Agent fallback
       └─ targeted Chat delivery
```

Machine, Knowledge, and Queue have separate authorities. Queue may refer to a Machine id when its observer is remote, but it does not own SSH. Knowledge has no Machine scope; an Agent combines selected Knowledge with current Machine Info at use time. Machine does not own Knowledge, monitoring, or Chat wakeups.

## Component lifecycle

The SLOP bundle contains Machine, Knowledge, Queue, Queue public callbacks, and Runtime support. Each business component has one DSH plugin identity with Host and client entries: the native Plugin Manager switches its tools, prompt contributions, settings and operations together. Runtime support owns browser admission/bootstrap, historical transcript renderers, Goal constraints, the labeled SLOP prompt block and the Agent behavior preferences; it owns no business data. See [Agent behavior and prompt block](runtime.md#agent-behavior-and-prompt-block).

Machine shutdown releases its authentication, transfers and owned SSH masters without issuing scheduler cancellation commands. Queue uses an optional Machine execution port; local checks continue when Machine is disabled. Queue shutdown stops observation and delivery, retaining the ledger/outbox. Callbacks dynamically depend on Queue and pause without losing their saved Plugin Manager preference. Knowledge is independent. Disabling a capability leaves its persisted data and readable historical cards intact, with operations unavailable.

The directory browser is composed by the standalone Web runtime bundle. Installing SLOP into an existing DSH keeps that Host's directory picker.

Bundled Skills use the native registry and filesystem provider under the owning capability's lifecycle. Machine contributes onboarding/discovery; Queue contributes tracking. Both contribute the same project-work resource, so it remains available while either capability is enabled. Disabling both removes that bundled contribution. The launcher uses `DSH_SLOP_SKILL_DIR` and does not replace the operator's `DSH_BUNDLED_SKILL_DIR`; independently installed user/project copies remain under their original owners.

## Chat ownership

A Chat may use zero, one, or many Machines. Every Machine operation names its Machine explicitly; there is no global current Machine.

The host supplies the exact current official DSH Workspace to Knowledge operations. Model input cannot nominate another Workspace or arbitrary directory. Agents on the same Host and principal share Home Knowledge. They share Workspace Knowledge only when their Chats use the same official Workspace.

Queue captures the exact owning Chat from host context when an item is tracked. Model input cannot nominate another Chat. The durable Chat reference contains the session id, working directory, and Agent preset so a stopped Chat can be resumed through the harness without inventing a product-specific conversation runtime.

Ordinary Agent trace means the normal Chat transcript: user messages, model messages, native tool calls, tool results, and typed presentation cards. DSH-SLOP does not create a setup Agent or setup run.

Chat adapters use sessionController for cold activation, sessionProjections for current preset state, and a registered Session projection for native Inbox delivery receipts. Chat definitions come from dsh-client-ui-chat and conversation registration uses uiConversation.events. Machine cards support both native and PTC Tool events.

## Public model tools

The complete model-facing surface is fourteen tools:

| Capability | Tool | Purpose |
| --- | --- | --- |
| Machine | `slop_setup_machine` | Show the interactive setup card |
| Machine | `slop_machine_list` | List saved Machines |
| Machine | `slop_machine_get` | Read one Machine and its Machine Info |
| Machine | `slop_machine_connect` | Register/correct, then establish protected access |
| Machine | `slop_machine_info_set` | Save or update approved operational context |
| Machine | `slop_machine_transfer` | Copy one file or directory between Host and Machines, or between two Machines through Host |
| Machine | `slop_machine_shell` | Run a general command on one Machine |
| Knowledge | `slop_knowledge_search` | Search Home and the current official Workspace |
| Knowledge | `slop_knowledge_read` | Read current Markdown and its digest |
| Knowledge | `slop_knowledge_write` | Atomically create or digest-guard replace one Markdown item |
| Queue | `slop_queue_track` | Record already-submitted work |
| Queue | `slop_queue_list` | Query ledger items |
| Queue | `slop_queue_get` | Read one item and observations |
| Queue | `slop_queue_update` | Patch, check now, subscribe, or unsubscribe |

These fourteen tools form the Base surface. Enabling the optional Queue webhook extension adds `slop_queue_prepare` and corresponding runtime prompt guidance; disabling it removes both. This tool prepares a scoped reporting helper before native submission and never submits work. The extension's dedicated loopback HTTP receiver and managed connector are separate from the browser server and optional to Queue Base.

There is no DSH-SLOP tool for analysis, validation, Artifact handling, general Workspace editing, referenced-file execution, job submission, cancellation, retry, or scheduler-specific scientific workflow execution. Knowledge writes are restricted to their configured Markdown roots.

## Upstream capabilities

The product keeps upstream Standard and Code presets. Native DSH shell, filesystem, planning, jobs, skills, and subagent facilities remain available. DSH-SLOP Skills teach the Agent when and how to combine those facilities with the fourteen tools; they do not add hidden authority.

When an existing product home still contains the retired `slop-chore` or `slop-pro` presets, the launcher appends an upstream Standard selection event to Chats whose effective preset is still retired, then moves those two product-generated preset directories out of DSH discovery. Chat history is not rewritten or deleted, and unrelated user presets are untouched.

Bundled Skill reference reads retain their true absolute paths for execution and file actions, while the native read row displays a path relative to the launcher-provided bundled Skill root. Other file reads keep upstream path presentation unchanged.

The product ships six Skills, including one compatibility entry. They are model instructions, not additional product authorities:

- `onboard-slop`
- `deep-discover`
- `machine-onboarding`
- `machine-discovery`
- `project-work`
- `queue-tracking`

`project-work` is the normal cross-capability workflow. It tells an Agent how to combine a user-installed domain Skill with Knowledge recall, current Machine facts, direct file evidence, execution, Queue tracking, and Knowledge writeback. `deep-discover` is the narrower inventory workflow; `machine-discovery` delegates to it. Neither is a fourth component.

## Security boundary

Setup values, key-file paths, custom notes, discovery output, shell output, and shell history are not content-redacted by DSH-SLOP. They are normal Chat or Machine Info content.

Knowledge Markdown is user- or Agent-authored reference material, not a higher-priority instruction source. Search or read cannot override user intent, Skills, approvals, tool policy, or Machine access controls. Agents must exclude credentials, protected terminal bytes, licensed contents, and unreviewed environment dumps before writing Knowledge. Knowledge path resolution rejects absolute targets, traversal, and root or symlink escape.

Passwords, passphrases, OTP values, and protected terminal bytes are different: they remain inside the owner-bound authentication WebSocket and never become ordinary Chat text or model tool arguments. This is transport separation, not content sanitization.

The host binds to loopback. Remote browser access and proxy configuration belong to the operator, outside this repository. An operator supplies any trusted host explicitly. SLOP's browser bootstrap, event, authentication, and Queue Settings routes retain nonce, same-origin, trusted-host, and bounded-input checks. Provider-owned routes keep their own independent policy.

Remote shell presentation uses the public keyed Tool view in both Standard and Code modes. Code mode may nest it under the upstream Run Code trace, but the child uses the same command/output card and label `Remote shell · <Machine>`. The separate connection challenge node remains materialized with hidden visibility once settled; removing a previously visible node would violate the incremental Chat projection contract. Machine chips and the expandable composer Jobs panel read existing authorities without creating new execution ownership.

## Storage authority

Machine records and Machine Info use the product relational authority. Knowledge Markdown files are the sole Knowledge authority; its search index is derived and rebuildable. Queue uses its own local SQLite ledger because it is an independent monitoring capability. Queue settings live in the same authority as a versioned singleton and are migrated additively. SSH control sockets and live leases are rebuildable runtime state, not authority. A referenced file remains under its original filesystem authority. A process or scheduler handle is evidence about externally submitted work; Queue never treats it as permission to submit or cancel work.
