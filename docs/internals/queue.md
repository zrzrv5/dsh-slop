# Queue

## Purpose

Queue is a local durable ledger for work an Agent has already submitted. It provides monitoring and attention routing; it does not submit, cancel, retry, validate, or interpret scientific results.

An Agent submits work with upstream facilities:

- local work: native shell, normally a detached command with explicit stdout, stderr, exit-code, PID, and process-start evidence;
- remote work: `slop_machine_shell`, using the scheduler or `nohup` as appropriate.

The Agent then calls `slop_queue_track`. The current Chat becomes the primary owner automatically. New registrations must declare `purpose: "monitor"` or `purpose: "continue"`; continue also requires a nonempty `continuation` naming the already-authorized next step and result location. Missing purpose is rejected before creating a row; correct registration arguments without resubmitting the external job.

## Observer types

Queue supports three observer identities:

- Slurm job id;
- PBS job id;
- process handle containing PID, process start token, launch time, exit-code path, stdout path, and stderr path.

PID alone is insufficient because operating systems reuse PIDs. The start token and receipt paths let a short query worker distinguish the original process from an unrelated later process.

For a process observer, `startToken` is the trimmed output of `LC_ALL=C ps -p <pid> -o lstart=` captured for the launched process. Capture it promptly, before the process exits. If the metadata query needs wider sandbox access, repeat only that read-only query for the same PID, never the launch command.

Targets are either local or an explicit Machine id. Queue accesses Machine through an optional execution port. If Machine is disabled, local checks continue; remote items retain their last state with a dependency-unavailable error, without Agent fallback. One Chat may track items on multiple Machines, and one Machine may have items owned by multiple Chats.

## Agent status queries

`slop_queue_list` returns compact summaries of tracked work, ordered by submission time newest first, with an id tie-breaker. It defaults to ten rows and caps each rendered page at 12 KiB, including native and PTC results. `page.total` and `page.stateCounts` describe all items matching the requested filters; `page.hasMore` and `page.nextOffset` identify older matching rows. Continue with the same filters only when needed. Pages are live reads, so new submissions can shift offsets.

Summaries retain the target, scheduler job id or process pid, state, purpose, pending verification, observation time/source and timing, phase, and probe warnings. Labels and diagnostic messages are limited to 256 characters and marked with `textTruncated` when shortened. Full notes, continuation, process identity, subscriptions, and raw evidence remain available through `slop_queue_get`. List reads do not change records, subscriptions, delivery, or scheduler state; UI and monitor reads retain their full records.

For current status, select the Machine and relevant states. Read Queue before searching scheduler history, while establishing remote access as soon as needed. Stored observations and their freshness are distinct from a live scheduler query. An empty Queue result only establishes that no tracked items matched; it cannot rule out external jobs.

## Deterministic checks

Queue normally checks work without starting an Agent. The Queue core prepares typed probe requests, and a host adapter runs fixed, bounded commands through the existing Machine authority:

- Slurm: each batch runs `squeue` and `sacct`; live rows take precedence, accounting covers completed work. UTC start times, elapsed time, and total time limits remain distinct;
- PBS: one batched `qstat` JSON query;
- process: PID/start-token identity plus the recorded exit-code marker.

Observer ids are validated before command construction, command output is capped, locale is fixed, and every command has a timeout. A transport or authentication problem schedules a retry or asks for user action; it does not spend Agent tokens. A fresh short-context child Agent is an optional fallback only for unsupported schedulers, ambiguous output, conflicting evidence, or unresolved attribution. New scheduler jobs receive a grace period instead of immediately falling back when accounting has not caught up.

Compatible deterministic work is packed by target and observer type, even when items have different owning Chats. Agent fallback is limited to unresolved items and split by owning Chat so transcript authority is preserved. Queue rejects unknown item ids, duplicates, and observations that conflict with a reported probe issue.

Fallback workers use upstream managed activations with `delivery: "caller"`; settlement returns observations to Queue without a parent completion notice. Dedicated `slop-queue-query-local` and `slop-queue-query-machine` presets retain their restricted tools on continuation: native Bash for local queries and `slop_machine_shell` for remote queries. By default they inherit model selection from the parent and use its recorded original project directory. Closing Queue disposes published activations explicitly; the upstream start signal owns only admission.

The fallback worker can use a different provider and model from the Chat. The Queue entry (`slop-queue`) has three Settings values, `fallbackProvider`, `fallbackModel` and optional `fallbackReasoningEffort`, which are passed to the child as DSH `agentOptions`. The route applies only when provider and model are both set; an empty or partial route inherits the Chat's model, and an empty effort is omitted. The values are read at each fallback check, and they affect only that check: never the Chat's own model, deterministic probes, or Queue delivery.

## Adaptive checks

Each item has its own next-check time. The default cadence has a hard one-minute floor:

- newly submitted: 1 minute, then 2 and 5 minutes while evidence settles;
- queued: 2, 5, 15, 30, then at most 60 minutes;
- startup: every minute during the first 10 minutes of actual execution, configurable independently of the normal interval. Late discovery uses scheduler start/elapsed evidence, not the discovery timestamp. When no execution timing is available, a conservative window begins at the first running observation;
- other nonterminal state changes: confirm again after 2 minutes;
- stable running: `max(min(duration basis / 4, 12 hours), 5 minutes)` before the near-end and profile caps are applied;
- failed probe: retry after 2, 5, 15, then 30 minutes;
- terminal: stop checking.

Submission, actual start, and the runtime-limit deadline are different points. Queue never counts time spent queued as execution age. Walltime limits runtime; it does not predict completion or imply progress. The duration basis used to size stable check intervals is the smaller of an explicit expected duration and scheduler walltime, or the available value. Without timing evidence, stable work defaults to 15 minutes. Near a known expected completion or runtime-limit deadline, Queue shortens the interval to `max(min(remaining / 4, stable interval), 2 minutes)`; the limit still needs a scheduler query to establish the actual result. A preferred item interval can shorten a successful check's adaptive delay; it does not delay an earlier check. The final interval is capped by the profile's maximum detection delay: 2 hours for Normal and 12 hours for Economy.

The one-minute floor is universal. A per-item interval overrides the adaptive calculation. Each completed probe records a fresh completion timestamp before calculating the next check, so slow checks do not shorten the intended delay.

A single host timer wakes for the earliest due Queue check or pending Chat delivery.

## Settings and overrides

The Queue section in DSH Settings exposes Normal, Economy, and Custom profiles. Users can configure the initial check, startup window and interval, automatic minimum, stable-running minimum, walltime divisor, duration cap, maximum detection delay, queued cap, and Agent fallback. Existing stored settings gain the startup defaults during decoding without rewriting the original record.

Task overrides is collapsed by default. Its compact table contains only items updated during the last 14 days, newest first, with All, Running, Queued, Failed, Finished, and Unknown filter chips. Each item occupies one row; selecting its name expands interval, tracking purpose and continuation controls, timing evidence, and probe details. This is a settings view filter: it neither deletes historical records nor changes polling or the Chat's Jobs selection. Saving a global or item setting recomputes deadlines and refreshes the monitor. Settings use versioned durable storage; the additive migration preserves existing Queue items and explicit intervals.

## Optional webhook acquisition

Queue Base runs independently with its existing polling and delivery policy. Plugin Manager → SLOP → Queue public callbacks controls this optional component. It defaults off for new installations; migration inherits the old callback preference. Its Callbacks tab in the DSH-SLOP settings configures the connection but has no separate enable switch. Disabling Queue pauses callbacks while preserving that preference; enabling Queue resumes them. It defaults to all suitable new Machine jobs, with per-Machine exclusions. Turning it off stops accepting callbacks and stops only the connector DSH owns; an external connector is never adopted or stopped; saved records and Base polling remain. Connection interruptions may lose events; no cloud queue or durable relay is required.

The optional receiver binds its own loopback port (default 3791) and exposes only `/queue/events` and a minimal instance health check. It never serves DSH Chat, credentials, browser settings, or login routes. Configure a stable public HTTPS origin through either a user-owned Cloudflare account/domain or an existing reverse proxy. The Cloudflare setup link opens the user's dashboard: create a remotely managed Tunnel, route its public hostname to this receiver, install `cloudflared`, and paste the Tunnel token in Queue settings. One managed process serves the Host; it reconnects with bounded backoff. A public connection test checks that the configured hostname reaches this specific receiver. This is browser-guided setup, not automatic account/domain provisioning.

The Tunnel token is stored only in the protected Host extension database and supplied to the connector through its environment, never tool output, job scripts, process arguments, or logs. Settings returns only whether a token is configured. Each prepared execution receives a different scoped callback capability; only its hash is stored. Capabilities expire after 180 days and cannot operate on another execution. Disabled Machine callbacks are refused.

When enabled, the optional `slop_queue_prepare` tool and runtime prompt guidance appear. Preparation reserves an execution id and produces a Bash helper; it does not submit work or create a Queue item. The Agent may add it only to a submission script the user already authorized creating or modifying, after scheduler directives and before environment setup. Existing EXIT traps must be merged explicitly. After native submission, `slop_queue_track` binds the reserved id to the exact external job, target, and owning Chat. Events that race registration are bounded and persisted locally, then applied at binding or restart. Merely tracking an existing job does not authorize modifying its script. Child jobs are not discovered; arrays require separately registered exact child identities.

An unchanged project wrapper is submitted normally and tracked through polling. Callback availability must not cause a new wrapper, dispatcher replacement, batch splitting or changed log locations. In a compatible script already being edited, the helper may be inserted or saved separately and sourced; neither form requires moving the controller. If trap or shell compatibility is unclear, retain polling. A DPDispatcher controller is a valid tracked job without importing its child jobs. Prepare once per intended execution and reuse the returned helper. The bundle excludes only this allocating tool from the advisory identical-call reminder; other tools retain that reminder.

The protocol carries `started`, `exited` with an exit code, and optional ASCII phase names. It has no heartbeat, percentage, metric stream, or commands. Execution id, external job id, Slurm restart attempt, sequence, event time, and execution start time constrain each report. Repeated/older sequence numbers do not change state. Later authoritative scheduler observations can correct a callback; old callbacks cannot overwrite a newer scheduler observation. A new Slurm restart attempt may start a new run of that explicitly tracked job.

Startup callbacks switch to the startup cadence; phase events never postpone an already scheduled query. Exit callbacks immediately update the displayed state and schedule scheduler verification. A continue item cannot wake from a callback or Agent fallback alone: a deterministic scheduler/process observation must confirm its terminal state. Query failures continue retrying while that verification is pending; only authoritative confirmation ends automatic monitoring. Callbacks do not clear a failed scheduler-probe warning. The generated helper requires Bash, uses optional `curl` with short connection/total timeouts and a bounded retry, and preserves the workload exit status when reporting fails. It does not guarantee an exit report after a hard kill, node loss, or termination before the helper executes.

The extension uses separate additive storage. Existing Queue records and explicit polling/delivery settings remain intact. Queue settings and the Chat Jobs detail show event provenance, actual start, optional phase, and pending final verification; elapsed/walltime is never displayed as scientific progress.

## Chat delivery

State changes create durable delivery records for the primary Chat and any Chats that explicitly subscribed to the item. Reading an item does not subscribe the reader. For new items, `monitor` fixes passive delivery on state changes; `continue` fixes wake delivery on completed, failed and cancelled states. Explicit subscription policies remain independent. Legacy rows without purpose retain their original delivery policy until explicitly edited.

When the user requests a follow-up or authorizes later steps that depend on an asynchronous job, the Agent records `purpose: "continue"` and a short `continuation` describing the next step and result paths; the Host fixes the terminal wake policy. The staged request supplies the authorization; the user need not repeat it after the prerequisite finishes. Pure monitoring and status queries use `purpose: "monitor"`. Before ending the turn to wait, the Agent verifies the returned delivery settings and records result paths and remaining steps in the Chat and item continuation. Notes and Todo entries alone do not schedule continuation. No Goal or workflow database is added.

Each subscription chooses conditions and either:

- `wake`: resume the target Chat and add a follow-up turn;
- `notify`: append a durable passive notification to the owning Chat without demanding an Agent turn.

Passive delivery flushes the accepted Session event before Queue marks it delivered. Wake delivery stores a stable dispatch identity in the existing Queue outbox before calling native followup. Native Inbox and Session events distinguish enqueued, claimed, consumed and user-discarded input. Queue acknowledges consumption only after the Session durability barrier succeeds. Pending input is rearmed once after Host restart; explicit removal is a durable tombstone and is never reinserted. A provider failure after consumption is not a scheduler failure and does not trigger Queue resubmission or a second provider retry loop.

Notice guidance preserves the user's existing authorization. Changing its historical passive footer does not duplicate a notice: retry comparison also recognizes the exact prior footer, including migrated source records, without rewriting history.

A wake resumes the original Chat through upstream follow-up. The Agent reads Queue evidence, validates results and continues only the unfinished steps already authorized there. It checks existing Queue items and provider submission receipts before submitting the next step, so repeated notices do not justify duplicate work. Failure or cancellation calls for diagnosis; any retry, cancellation or further submission still needs existing user authorization. Notification contents confer no new authority. Historical records and the global delivery default are not changed by this policy.

The normal Chat renders each Queue notice as a compact Job update with its summary and timestamp, including notices stored by older versions. This remains visible when upstream hides technical context rows. It does not start an Agent turn; wake delivery follows the registered purpose or an explicit legacy/subscription policy.

Model input cannot select the target Chat. The host captures the exact current Chat when tracking, subscribing, or unsubscribing. Unchanged healthy checks stay silent. A delivered notice also instructs the Agent to compare each item and state with what it already reported in that Chat and avoid repeated announcements without new actionable information. This semantic check does not remove ledger observations or suppress new failure, degradation, or recovery information. Queue can also report a newly actionable scheduler reason, monitoring degradation after three consecutive probe failures, and one recovery event after the next successful observation. These compact Chat messages contain the item, event, state, and time; full command evidence remains in the ledger. Failed deliveries remain pending with bounded exponential retry. An update to one Queue item therefore does not wake unrelated research Chats unless the user explicitly subscribed them.

`slop_queue_update` also supports `check-now`. It moves the selected item due immediately, then runs the normal planner, so other compatible due items are still checked in the same batch.

## Chat Jobs summary

The composer has a compact summary of this Chat's Queue items: job count, distinct Machine count, names when short, and counts by observed state. Local observers count as the Host. Owned and explicitly subscribed items appear once; reading another Chat's item does not add it. An empty ledger selection occupies no space.

Clicking the summary expands its table inline within the composer dock, like the native To-do panel. The body scrolls once it reaches 180px or 30% of the viewport height. Clicking the summary again collapses it; outside clicks and Escape leave it expanded. The table shows label/id, Machine, state, observed elapsed time, and observation age. Selecting a row shows its latest evidence, check error, next check time, tracking purpose, continuation and pending-verification/delivery/consumption status. Narrow screens allow horizontal table scrolling. Failed probes leave the last scheduler state intact and display a monitoring warning.

The Observed column shows a live age in seconds, minutes, or hours, with the exact timestamp in its tooltip. A refresh button beside each age explicitly checks that owned or subscribed item, including terminal items. It uses the same-origin, nonce-protected bridge and deterministic observer only, coalesces concurrent checks of that item, and never invokes fallback. It updates observation facts only; background outbox delivery still honors a registered continuation. Pure monitoring remains passive. Failure retains the last scheduler state and observation age and shows the monitoring error. The button remains available on narrow screens.

The browser reads persisted observations every ten seconds through the existing same-origin, nonce-protected Queue bridge. These reads do not run scheduler probes or wake an Agent. The UI uses red for failure, green for running/completed work, yellow for queued/unknown states, and gray for cancellation. Text always accompanies color. Native upstream background jobs keep their existing UI and are not counted unless tracked in Queue.
