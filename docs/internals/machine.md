# Machine

## Setup flow

Setup is opt-in. A new Chat does not show a connection card.

`/onboard-slop` scans literal Host aliases in `~/.ssh/config` and bounded Include files without executing SSH configuration commands, connecting, or reading private keys. The Agent compares candidates with saved Machines and asks the user to select or confirm them before continuing. Configuration values are hints; OpenSSH resolves the selected alias at connection time. Missing configuration falls back to a manually supplied SSH target.

`/setupmachine` remains a manual shortcut. Both commands start an ordinary upstream Agent turn. The Agent renders the interactive card through `slop_setup_machine` only after explicit setup intent. Command-only history no longer creates cards: in Harness 0.2.0-rc.2 those histories remain blank and can be reused by New session.

The card requires SSH target, authentication mode, and scheduler. Alias, paths, custom notes, and Deep Discovery are optional. Harmless trailing directory separators are normalized when saving setup paths; ambiguous paths remain rejected.

The card has one title and shows the required connection fields first. Paths, notes, and discovery options are in an expandable section. The form stays in the main transcript outside collapsed tool activity. Its submitted call id restores the accepted values as read-only history after reopening Chat. A submitted card becomes a compact read-only request row; live connection state remains in the connection card. Machine Info shows a brief operational summary with connection, path, discovery, and audit details available on demand. Empty optional fields are omitted.

Setup, submitted requests, connection challenges, Machine Info, transfer progress, and expanded Remote Shell output share the native Tool card's theme background, thin border, and 12px corners. The shared Machine projection subscription reloads its baseline and reconnects after a dropped feed or cursor gap, with bounded retry delays. Authentication challenges arriving after a Chat opens appear without a page refresh.

Each new pending Machine Tool card revalidates the shared connection snapshot and subscription. The feed sends a cursor heartbeat every ten seconds; thirty seconds without a frame triggers recovery even when the browser receives no socket error. Browser focus, page restore, and network recovery also revalidate the snapshot. Expired connection waits settle without further browser activity, remove sign-in actions, and let the ordinary Chat continue with a retryable failure. Retained or expired cards cannot automatically reopen sign-in.

The card fields are:

- optional Machine alias;
- SSH target in `user@host` or SSH config alias form;
- explicit `Requires 2FA` or `Passwordless key` choice;
- local key-file path when passwordless key is selected;
- explicit scheduler choice: Slurm, PBS, none, or unknown;
- optional home, work, and scratch paths;
- optional custom notes;
- optional Deep Discovery checkbox.

Selecting **Connect** submits one bounded, non-secret tagged user message through the current Chat composer. The original card becomes read-only. The tagged message remains model-visible so the same Agent continues; its raw envelope is not shown as a duplicate user bubble or second Setup card.

The Agent must then:

1. call `slop_machine_connect` with the accepted setup fields;
2. receive the saved `machineId`;
3. immediately call `slop_machine_connect` again with only that `machineId`;
4. if authentication is needed, wait on the same tool call while the protected inline card carries SSH prompts and 2FA;
5. continue the ordinary Chat after access is ready.

No new Agent or product run is created. The suspended tool call resumes after protected authentication succeeds.

A ready transport does not prove that the account's shell startup lets commands run. After `connection.require` returns ready, `slop_machine_connect` runs one fixed, side-effect-free command (`printf` of a marker) through the ordinary remote shell path with a 15-second limit, and adds `sessionCheck` to the ready result. When the marker prints, `sessionCheck.ok` is true; any stderr from startup files is returned as `startupStderr` and labeled as noise, because some clusters' profile scripts call `stty` in every non-interactive session. When the marker does not print, `sessionCheck.ok` is false and its message names the usual account-side causes (startup files that print, `exec` another shell or wait for input) and tells the Agent to run no other command on that Machine. The connection itself stays ready; nothing is retried or repaired automatically.

In Windows WSL mode, the control-socket check prints a marker before testing the directory. A missing marker means WSL could not run a Linux command at all, which is reported separately from an unsafe socket directory; the directory message names the failed condition (owner, mode, symbolic link, creation). A failed connection is diagnosed in ordinary Chat; the Agent may show a newly prefilled setup card for another user-approved attempt or the user may abandon it.

## Connection reuse and shell

On Windows, Machine defaults to a native `ssh2` transport with no WSL dependency. The Windows OpenSSH Client resolves configuration through `ssh -G`; the plugin owns a persistent native connection with independent exec and SFTP channels. Key files, the Windows named-pipe agent, encrypted-key passphrases, passwords and keyboard-interactive/2FA are supported. Human responses use the existing owner-bound authentication socket, stay in memory and are never echoed or recorded in ordinary Chat. Enabling the plugin does not start SSH or resolve configuration.

Native aliases and `~/` keys belong to the Windows user's `.ssh` directory. `/onboard-slop` scans that directory and bounded Includes. Drive/UNC paths remain Windows paths; remote paths and command text remain unchanged. Native connections use Windows networking, so there is no separate WSL DNS or VPN route. VPN access still depends on the Host process's network permissions and routing.

Native configuration supports hostname, user, port, identity files, IdentityAgent, IdentitiesOnly, known-host files, HostKeyAlias, authentication enablement, AddressFamily and BindAddress. Transport algorithms are the intersection of the resolved SSH policy and supported modern algorithms. ProxyJump, ProxyCommand, SSH certificates, hardware-key providers, agent forwarding, BindInterface and adoption of user-owned OpenSSH masters are rejected explicitly. Set `DSH_SLOP_SSH_BACKEND=wsl` before restarting Harness to use those OpenSSH configurations on Windows; `DSH_SLOP_WSL_DISTRO` selects the installed distribution. WSL mode uses its own SSH aliases, keys and agent, and translates explicit Windows local paths with `wslpath`. No keys or configuration are copied automatically. Existing WSL-only setups must retain that backend or be configured separately for Windows.

`slop_machine_shell` is the general remote execution primitive owned by Machine. It accepts an explicit Machine id, command, optional working directory, and timeout. It returns exit status, stdout, and stderr. It does not redact command output or shell history.

`slop_machine_transfer` copies one regular file or directory over existing connections. Native Windows uses SFTP channels; macOS/Linux and optional WSL mode use system `scp`. Host-to-Machine and Machine-to-Host use one saved Machine connection. Machine-to-Machine streams through the Host using two SFTP channels or `scp -3`; A and B never connect to each other and payload bytes are never staged in a Host file. Native directory copies refuse symlinks and unsafe filenames and cap traversal at 100,000 entries and 64 levels. Local-to-local copies remain native `cp`; copies within one Machine remain ordinary `slop_machine_shell` work. Chat shows bounded byte/entry progress for native SFTP or `scp`'s PTY progress, with full retained progress in presentation metadata. Failed transfers return a bounded diagnostic and report a possible partial destination. SFTP is the default. Explicit `protocol: "scp"` selects `scp -O` only with an OpenSSH backend; native Windows rejects it before copying. There is no automatic fallback or replay.

User-requested or established suitable transfer methods take precedence. Otherwise the managed transfer is the fallback; the Agent need not exhaust unrelated alternatives. For directory copies, the Agent uses bounded checks of the exact source to assess file count, approximate size, destination conflicts and space. Many small files favor a unique source archive and destination staging directory, with compression considered separately. Verify the archive hash and extracted layout before publication, refuse unapproved overwrites, and remove only this operation's temporary artifacts after success. A failed recursive copy is not a prerequisite for selecting tar.

The host resolves the latest Machine and access revisions before every call. Connection identity includes the access profile revision, key-file path and effective idle/keepalive policy. Native Windows connections are closed when a profile changes, the Host stops, or Machine is disabled; they are never persisted or reconstructed as ready after restart. Product-owned connections may be reused only for the same effective profile and have an idle horizon of at least 12 hours while the Host runs. OpenSSH passes that horizon to ControlPersist; native mode reaps idle connections. The connect Tool reports the horizon. Purpose-scoped leases and transport handles never cross the model boundary.

`slop_machine_get` keeps `baseConfiguration` as the exact saved inventory baseline. For an SSH Machine, `sshIdlePolicy` separately reports the configured idle value and the effective runtime value. An app-managed legacy profile may therefore retain `configuredIdleSeconds: 600` while reporting `minimumIdleSeconds: 43200` and `effectiveIdleSeconds: 43200`; reading this projection does not mutate the saved Machine or its access revision. Direct and user-owned masters do not receive the product-owned minimum.

Interactive secrets are never tool parameters. If access is not ready, the call enters the same protected authentication flow used by setup.

## Deep Discovery

Deep Discovery is the `/deep-discover [Machine and scope]` command and `deep-discover` Skill. An ambiguous Machine requires user selection. The setup checkbox only injects a request to use this same Skill after confirmed connection readiness; it does not run a second discovery implementation. The older `machine-discovery` name delegates to it for compatibility. The Agent searches relevant Home and current Workspace Knowledge, and uses the general remote shell to answer bounded questions about the actual Machine and request. Existing Knowledge can prevent repeated project inspection, but it is not evidence that a Machine still has the same configuration. The Skill supplies selection and evidence policy. Omitting command and evidenceFiles in a census or project-read request selects a Host-generated bounded page; discovery.focus selects a previously observed workstream. The Agent still chooses useful questions and can use explicit read-only commands for site-specific operating facts.

Research discovery is project-first. The Agent starts from project names, exact paths, Custom notes, approved Machine Info, selected Knowledge, recent commands, and the user's current request. A declared work, home, or scratch root is authoritative: project-related calls use it as `workdir` and do not walk through parent directories to rediscover it. The Agent builds a small candidate list, asks the user to disambiguate when needed, then inspects selected projects by exact path.

Discovery partitions what it learns. Machine Info records connection state and approved current operating facts, such as scheduler/account choices, module or executable setup, filesystem roots, and submission defaults. Systematic methods that survive a Workspace change go to Home Knowledge. Finer project decisions, Machine/path provenance, canonical script references, one-time work, and not-yet-systematic findings go to the current Workspace Knowledge. Raw outputs and live job state remain in their original files and Queue. A Machine or path reference in Markdown never becomes a Knowledge scope or a substitute for checking current Machine Info.

Deep never means scanning more of a filesystem. When the user supplied a home-relative path or a path in notes, `slop_machine_shell` accepts `discovery.phase: resolve-root` with that exact `root`, `purpose`, and a timeout of at most 20 seconds. This request omits command, workdir and evidence fields. The Host builds a quoted read-only directory lookup; it does not enumerate contents. A successful absolute result becomes a discovery root for the current turn, without saving Machine Info. New Machine Info path writes must be absolute and single-line; historical records remain readable and are not rewritten. The Agent does not ask the user to execute this available lookup.

Discovery commands run one at a time with short timeouts and bounded output. The default budget is one bounded root map, optional scheduler and Queue summaries, and normally two calls per selected project. Exact declared projects can skip the root map. The censusPage result contains initially unclassified entries and completeness; an empty census is valid. Repairs require a user-relevant unresolved fact, not an unused quota. Broad inventory still accounts for every root-map entry, but selects at most twelve roots for deep reads and permits at most 32 shell attempts; unselected entries retain an explicit evidence tier instead of triggering another traversal. Adjacent small checks for the same question are bundled. Root-wide globs, recursive `du`/`find`/`tree`/`grep`, global size or mtime sorts, sorting before an output limiter, loops over every directory or Git repository, and reads of large scientific outputs are forbidden when scope or cardinality is unknown. If a bounded check is insufficient or times out, the Agent preserves the uncertainty or asks the user which gap matters; it does not broaden the scan.

The Agent may use custom notes and all command output without product redaction, but it excludes secrets, protected terminal content, licensed file contents, and unreviewed remote instructions from Knowledge. During Deep Discovery, the runtime also rejects overlapping Knowledge writes, oversized new discovery documents, and content containing the selected Machine's literal roots, identity-bearing root parents, endpoint, or username; portable anchors remain allowed. It independently creates or performs digest-guarded updates to appropriate Home and Workspace Knowledge as reusable findings become clear, without per-write approval, and retains each write receipt. When new or changed operating facts justify Machine Info changes, it prints the complete proposal and obtains required approval before saving; unchanged operating facts do not require another proposal. It reports every successful Knowledge write receipt separately. It never asks whether the user wants to see findings that have already been gathered and does not use a separate question card for initial Machine Info approval.

The exact visible Machine Info proposal requires explicit user approval before its initial save. That choice controls only `slop_machine_info_set`; it neither authorizes nor rolls back Knowledge writes. A user correction to a Knowledge item follows the normal digest-guarded update path. A digest found stale during verification or an existing create target is a visible conflict and causes no write.

Discovery is complete after reporting supported findings and unknowns, any required Machine Info proposal, and receipts for useful Knowledge deltas. Twelve projects is a cap, not a default target. Complete representative reads for a small batch before broadening to the next batch.

The Host compiles discovery census, project candidate pages, focused workstream pages, and selected evidence reads; Skills do not carry executable command templates or result parsers. EvidenceFiles may include an exact absolute reference returned by that project only within a declared root on the same Machine. Guessed cross-project paths remain denied. Direct edges require observed source lines, with scheduler directives distinguished from worker commands; structural checks do not establish scientific meaning or execution success.

One remote parser diagnostic permits a bounded corrected command; another stops discovery. A known Knowledge conflict, invalid argument/Markdown, missing target, or bounds rejection permits one correction, while an unknown write outcome, security denial, exhausted correction budget, or outer failure after a nested write remains terminal. Successful nested writes remain protected even if another write in the same program fails. Existing section updates validate changed evidence without requiring unchanged inventory tables to be resent.

## Machine Info

The model-facing initial candidate and typed update changes expose their complete field schemas. Invalid requests identify missing or invalid fields; an installed Agent does not need access to the product source repository to construct a request.

Machine Info is durable operational context for future Agents using that Machine. Its read-only card shows setup facts, custom notes, approved discovery summary, operating defaults, Machine-specific project placements, and operational sections. `slop_machine_get` returns the same context so later work can choose commands and paths intelligently.

Machine Info owns connection state and approved current operating facts: access, scheduler and account details, partitions or queues, modules and environments, executable builds and paths, pseudopotential locations, filesystem roots, and submission defaults. Knowledge may mention a Machine or path as provenance or a reusable file reference, but the Agent verifies it against current Machine Info and the filesystem before planning work.

Initial Machine Info always requires explicit approval in the current Chat. Updates are graded by typed change:

- small additions or corrections may be applied without prior approval, but the Agent must explain them in Chat;
- material replacements or access, scheduler, path, or operating-default changes require explicit approval;
- initial and material changes emit a new read-only Machine Info card.

Settings lists saved Machines and details. Its separate Knowledge section configures the Home Knowledge root and shows read-only source status for every registered Workspace. Retrieval remains limited to Home and the current official Workspace. Setup, connection, discovery, correction, and Knowledge writes remain Chat workflows.

## Chat status and shell presentation

Saved Machines appear as compact chips in one row below the Chat header, without an enclosing panel or visible group label. All saved Machines remain in the row; horizontal scrolling reveals any that do not fit, including on touch screens. Machine details open outside the scrolling strip. Connection observations refresh through the existing event feed; unavailable feeds and expired leases do not display green readiness. Inventory refresh is read-only. Connected chips show details. Clicking a disconnected chip submits a connection-only request through the current Chat; a nonempty composer draft or attachments are preserved and block that submission. Authentication and host-key review continue through the existing protected Chat card.

Remote shell calls use the upstream keyed Tool presentation seat for both native and PTC child calls. The card shows the command, Machine, workdir, settled duration and exit status, separate expandable stdout/stderr, and raw evidence. Long output previews are bounded and labeled. Output arrives with the existing execution result; this view does not claim live command-output streaming. A diagnostic command's exit status is independent of any scheduler state in its output.

## Remote output and failure recovery

Machine's system-prompt contribution tells the Agent to present remote-only filenames and paths as inline code, without Markdown/file links. A verified local copy may be linked normally.

An SSH channel failure after dispatch does not establish that a command never ran. Connection errors retain bounded OpenSSH diagnostics; command-channel errors explicitly warn of uncertain execution. A timeout preserves `timedOut` and does not prove the remote process stopped. Inspect process/output state before retrying mutations. Long-running scientific work belongs in a background process or scheduler with Queue tracking; `timeoutMs` remains configurable for bounded foreground work.
