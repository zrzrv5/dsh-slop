# Queue

Queue is a local ledger of work an Agent has already submitted. It follows the work and tells the right Chat when something changes, so the Agent does not have to poll and a finished job is not forgotten when the Chat ends. It does not submit, cancel, retry or interpret results.

## Track a job

The Agent submits work with DSH's normal tools: the local shell for local work, `slop_machine_shell` for a cluster. It then calls `slop_queue_track` with the receipt. The current Chat becomes the owner, taken from the host and not from model input.

Three kinds of job can be tracked:

- a Slurm job id;
- a PBS job id;
- a local process, identified by PID, start token and exit-code file (a PID alone can be reused by the OS).

Every item declares a purpose:

- `monitor`: send a passive notice when the state changes.
- `continue`: also wake the owning Chat when the job finishes, so it can run a next step you already authorized. The Chat wakes only after a deterministic check confirms the terminal state.

`slop_queue_list` and `slop_queue_get` answer status questions from the ledger. An empty result means nothing tracked matched, not that no other jobs exist.

## How it checks

Queue normally checks without starting an Agent. Fixed, bounded commands run through the [Machine](machine.md) connection: `squeue` and `sacct` for Slurm, `qstat` for PBS, process identity for local work. Output is capped, every command has a timeout, and ids are validated first. If a connection is down, Queue keeps the last observation, retries, and asks you for action when needed; it spends no model tokens on that.

Each item has its own next check. Checks come often right after submission and start, back off while a job is stable, and tighten near its time limit. The floor is one minute. A short-context Agent is a narrow fallback for output the checks cannot interpret.

The Queue tab of the DSH-SLOP settings has Normal, Economy and Custom profiles, per-item overrides, and an optional separate model for the short fallback check worker. The composer shows a compact summary of this Chat's jobs, with an inline table and a refresh button.

## Notices

When a job changes state, the owning Chat and any Chat that explicitly subscribed get a compact Job update. Unchanged healthy checks stay silent. Failed deliveries are kept and retried, including across a Host restart. An update to one job never wakes an unrelated Chat.

## Optional webhook

Off by default. Job scripts report `started` and `exited` to a receiver on its own loopback port, which you expose through a Cloudflare Tunnel or your own reverse proxy. Queue then learns about a start or exit sooner than its next check, and still confirms the terminal state with the scheduler. The receiver serves only the event route, each prepared run gets its own expiring token, and the helper never changes the job's exit status. It cannot report a job that is killed hard. `slop_queue_prepare` appears only while the webhook is enabled and never submits anything.

Full contract: [internals/queue.md](internals/queue.md).
