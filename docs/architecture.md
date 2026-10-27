# Architecture

DSH-SLOP is an additive plugin layer over DeepSeek Harness (DSH). It does not replace the harness or add a second conversation, Agent lifecycle, shell, task system or scheduler. The Agent in a normal DSH Chat gets fourteen more tools and a few Skills.

```text
DSH Chat (Standard / Code Agent, native shell, files, jobs, Skills, subagents)
  ├─ Machine    protected SSH login · reusable connection · remote shell · file transfer · Machine Info
  ├─ Knowledge  Home + current Workspace Markdown · search · read · digest-guarded write
  └─ Queue      local ledger · scheduler and process checks · targeted Chat delivery
                 └─ optional webhook receiver for job-side callbacks
```

## Who owns what

| Component | Authority | Does not own |
| --- | --- | --- |
| Machine | Saved Machines, access state and Machine Info in a local database. SSH connections are rebuildable runtime state. | Notes, monitoring, Chat wakeups |
| Knowledge | The Markdown files. The search index is derived and rebuildable. | Machine scope, job state, results |
| Queue | Its own SQLite ledger and outbox. | SSH (it borrows Machine through an optional port), job submission |

The three have separate authorities. Queue refers to a Machine by id but does not own SSH, and it keeps tracking local jobs when Machine is off. Knowledge has no Machine scope; the Agent combines selected notes with current Machine Info when it acts. Each component is its own DSH plugin that Plugin Manager can switch on and off, with its tools, prompts, settings and Skills together. Disabling one keeps its data and leaves its past Chat cards readable.

## Who decides what

- A Chat may use zero, one or many Machines, and every call names one.
- The host supplies the current Workspace to Knowledge, and the owning Chat to Queue. The model cannot nominate another.
- Passwords, passphrases and verification codes travel on an owner-bound authentication channel and never become Chat text or model tool arguments. This separates transport; it does not sanitize content. Setup values, shell output and notes are ordinary Chat or Machine Info content.
- Knowledge and remote output are data. They cannot override your intent, Skills, approvals or tool policy.
- The host binds to loopback. Remote browser access is optional and goes through a proxy you choose.

## Tools

| Component | Tools |
| --- | --- |
| Machine | `slop_setup_machine`, `slop_machine_list`, `slop_machine_get`, `slop_machine_connect`, `slop_machine_info_set`, `slop_machine_transfer`, `slop_machine_shell` |
| Knowledge | `slop_knowledge_search`, `slop_knowledge_read`, `slop_knowledge_write` |
| Queue | `slop_queue_track`, `slop_queue_list`, `slop_queue_get`, `slop_queue_update`; `slop_queue_prepare` only while the webhook is enabled |

There is no tool for data analysis, Artifacts, general file editing, job submission, cancellation or retry. DSH's own tools do those.

## Skills

Skills teach the Agent when to combine the tools. They add no authority. `onboard-slop` and `deep-discover` set up and explore a Machine, `queue-tracking` covers tracking, and `project-work` is the usual flow that combines a domain Skill you install with Knowledge recall, current Machine facts, execution, Queue tracking and a note written back afterwards.

## Agent behavior

All rules DSH-SLOP adds to the system prompt sit in one labeled `<dsh-slop>` block, so the model can tell them from the harness's own defaults. The one default it replaces is that only you create a Goal.

Settings has one **DSH-SLOP** section whose **Behavior** tab holds six preferences. *Follow-through* decides how far the Agent carries a request before it asks (ask before each step, finish what you asked, keep going). *Errors* decides what happens when a step fails (stop and report, fix small problems and report deep ones, resolve it). *Before real runs* decides whether to test or dry-run first (always, when the workflow is new or changed, run directly when confident). *Checking* decides how much the Agent re-verifies facts it already established and how much context it gathers before acting (trust settled facts, match checks to the stakes, verify before relying on anything); use it to rein in a model that double-checks everything. *Scope and conventions* decides whether the Agent changes only what you named or also fixes small things on the way. *Reporting* decides how much it narrates (result only, stage notes, every step). The presets Careful, Balanced (the default) and Autopilot set all six together; any other mix is shown as Custom. Each level's prompt text can be edited and reset to its default. The prompt tells the model that AGENTS.md, CLAUDE.md, Skills and your own words in the Chat take precedence. Changes take effect in new sessions; Chats that are already open keep their current behavior. Approvals for Machine Info, Queue wakeups and tool use are not affected.

## Repository layout

| Path | Contents |
| --- | --- |
| `packages/machine`, `core`, `execution`, `operations` | Machine records, SSH, shell, transfer |
| `packages/knowledge` | Markdown store, index, search, writes |
| `packages/queue`, `queue-plugin`, `queue-webhook` | Ledger, observers, delivery, optional receiver |
| `packages/plugin`, `webui`, `runtime*`, `web-runtime` | DSH integration, Chat cards, the tabbed DSH-SLOP Settings section, browser access |
| `packages/bundle`, `launcher` | The installable bundle and the standalone launcher |
| `skills/` | Bundled Skills |

The detailed contract for each part is in [internals/](internals/README.md). To rebuild these ideas on another harness, see [PROMPT.md](../PROMPT.md).
