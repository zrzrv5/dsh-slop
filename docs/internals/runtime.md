# Standalone runtime and external configuration

`packages/` is the reusable product. `pnpm dev` loads DSH base, Web App, the SLOP capability bundle and the upstream Worktree and Plugin Market additions. Model providers, account state, proxy services and machine-specific deployment are configured outside this repository.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm dev -- --no-open
```

The launcher uses a separate product home. Pass `--home /absolute/path` to select an existing compatible home after stopping its Host. It does not copy credentials or histories between homes. Unknown unmarked homes require a separately reviewed migration. Home Knowledge defaults to `~/.slop/knowledge`; configure a separate root when testing should also isolate Knowledge.

The launcher accepts `--runtime /absolute/path/to/installed-bundle`. The selected directory must contain a versioned DSH bundle package and its installed dependencies. The launcher adds that bundle after core and links it into the generated profile. No runtime is discovered from the current working directory. A conflicting existing runtime link is rejected rather than replaced. The external bundle and its dependencies are maintained outside this repository.

The generated profile manifest selects the composition. Startup updates launcher-owned dependencies and retains external plugins, their selected bundle order and disabled dependencies. It records optional runtime ownership so a subsequent core launch does not retain a previously launcher-selected runtime. Put user overrides in `dsh/profiles/slop/cordis.patch.yml`; startup creates this file only when absent and preserves existing bytes except for the documented one-time component migration.

`pnpm build:core` builds the launcher and its workspace dependencies. `pnpm release:pack` packages that dependency closure. Neither includes an operator's external runtime or configuration.

The Web UI build writes browser assets into the packages that own each component, then runs their `sync:client` scripts so pnpm refreshes injected workspace copies after those files exist. This applies to full builds and filtered core/plugin builds. `pnpm launcher:smoke` checks the real standalone entrypoint, served client assets, bootstrap, settings and plugin inventory in a fresh temporary home. These checks do not deploy a running instance.

Product homes, credentials, profile overrides, service configuration and backups stay outside the source tree. The standalone home defaults to the platform's application-data directory; on Windows it is `%LOCALAPPDATA%\dsh-slop`. Profile package directories use junctions on Windows. See [Machine](machine.md#connection-reuse-and-shell) for native SSH and optional WSL mode.

## Upgrade behavior

Stop the Host before upgrading a product home. Historical unversioned Session files are validated through DSH's released format catalog, then copied to canonical `session.vN.jsonl` or `session.vN.jsonl.zstd` names. Copies are published atomically and the original files stay unchanged. A missing final newline in plaintext is repaired in the canonical copy only. Already published generation files remain authoritative.

Before upstream imports `settings.yaml`, launcher preparation renames the legacy `dsh-slop-knowledge` section to the existing `slop-knowledge` profile entry. It saves the unchanged original as `settings.yaml.before-dsh-017`, preserves unrelated settings, and refuses malformed roots or conflicting sections. Interrupted preparation can resume against a matching backup. DSH then owns importing those settings into the profile patch.

Legacy `slop-chore` and `slop-pro` histories receive an appended Standard preset selection through the upstream Session handle. All discovered Sessions are read before preset changes begin. DSH owns write locks, generation encoding, successor publication, and durability. A failed or interrupted migration leaves its completion marker unset and can be retried after the cause is fixed. Retired product preset directories move out of discovery only after successful processing. Unknown, malformed, or unsupported histories are refused.

DSH converts supported V3 histories to V4 while retaining previous generations; V0–V2 histories pass through the released conversion chain first. Upgraded histories cannot be read by older DSH versions. Keep a full product-home backup for rollback and restore that backup only after stopping the newer Host. Queue's stored `code` targets are interpreted as `ptc` when resuming their migrated Chats; the ledger is not rewritten.

The release uses upstream public Session Controller, projection, and split Chat APIs. Machine cards derive from raw native and PTC events; the previous patches to bundled upstream JavaScript are removed.

## Capability migration and rollback

Before linking the new capability bundle into an existing home, the launcher verifies that its authority, Queue and callback databases have no running Host owner. It maps legacy Host enablement to Machine and Queue, preserves Knowledge and unrelated profile overrides, and copies the old callback preference into the native Plugin Manager override. A disabled Queue pauses an enabled callback component. SQLite's old enabled field is read only for this migration; runtime settings no longer consult it.

The migration writes owner-only originals and a digest receipt under .component-migration-v1/. Profile publication is atomic and an interrupted publication can resume. A custom legacy Host/UI configuration, duplicate or mixed override, or independently disabled old UI is refused before publication because it cannot be mapped without a decision. No Machine/Queue IDs, Chat references, Knowledge roots or database locations change.

For deployment, stop the managed Host and make a full product-home backup before startup. To roll back, stop the new Host, restore the saved checkout/runtime version and full home backup, then start it with the original home and arguments. The migration's cordis.patch.yml.before, package.json.before, and consistent webhook.sqlite.before are additional recovery originals; copying only the old profile into a new capability bundle is not a runtime rollback. External services and their credentials are outside this migration.

Queue records a shutdown checkpoint in its existing outbox for exact pending native Inbox message identities on SIGTERM/SIGINT. This handles the pinned upstream release's generic cancellation during Agent teardown. Recovery creates a fresh native message identity with the same dispatch identity; a subsequent user removal cannot match the old checkpoint and remains discarded. Abrupt termination recovers from persisted Inbox/Session state. This does not retry a consumed model request.

## Agent behavior and prompt block

Every DSH-SLOP rule reaches the model inside one labeled block, `<dsh-slop>…</dsh-slop>`, so it can tell plugin rules from harness defaults. Capabilities contribute ordinary prompt sections named `slop:*` (Machine, Queue and the optional webhook each add one). The runtime's assemble listener removes them, adds the Goal rules when the harness `tool:goal` section exists, and inserts a single `slop:block` section after the harness sections and before the deployment persona suffix. The block opens by saying that its rules apply only to the `slop_*` tools, SLOP Skills and the changes it names, and that everything outside it is the harness's default. It names the one harness default it replaces: Goals are created only by the user. Nothing is added when no `slop:*` section is active.

The `slop-runtime` entry owns the Agent behavior preferences: six volatile traits and their prompt-text overrides. The data lives in `behavior-catalog.ts`, which the Host and the browser share. Each selected level contributes one short paragraph to a `slop:behavior` section, which the block places last, after the Goal rules. The paragraphs follow a preamble stating that project and user instructions (AGENTS.md, CLAUDE.md, Skills, and what the user says in the Chat) take precedence whenever they conflict.

| Trait (setting key) | Level | Behavior |
| --- | --- | --- |
| Follow-through (`followThrough`) | `confirm` | Do what was asked, then stop and report; ask before any step the user did not request. |
| | `authorized` (default) | Complete the requested steps, including ones that wait on a running job; ask only for an outcome-changing decision, an approval, or a blocker. |
| | `autonomous` | Start the next stage that follows from the stated objective; stop when nothing can advance or an action needs approval. |
| Errors (`errors`) | `stop` | Stop at the first failure and report what failed, what was tried, and the evidence. |
| | `triage` (default) | Spend a bounded effort on the cause; fix small local problems, report deep or unclear ones. |
| | `resolve` | Keep working until fixed or clearly impossible, returning to the original request after each fix. |
| Before real runs (`verification`) | `always` | Dry-run or test before every real run when possible. |
| | `when-new` (default) | Test first when the command or workflow is new or changed; reuse proven ones directly. |
| | `direct` | Start the real job when inputs and workflow are known good; test when asked or when a wrong run is expensive. |
| Checking (`checking`) | `lean` | Trust what was already read or run; gather only the context needed; verify once at the end and stop. |
| | `proportionate` (default) | Re-verify when something may have changed or a wrong result is costly; otherwise move on. |
| | `thorough` | Re-read and re-check state before each dependent step; confirm from more than one source when possible. |
| Scope and conventions (`scope`) | `strict` (default) | Use existing scripts and conventions; change only what the request names and mention anything else. |
| | `improve` | Prefer existing conventions, fix small adjacent problems, and name every unrequested change. |
| Reporting (`reporting`) | `brief` | One report at the end with the result, its location, and anything left undone. |
| | `standard` (default) | A short factual note when a stage starts or ends or the plan changes. |
| | `detailed` | Narrate what was run, observed and decided at each step. |

Presets set all six traits at once: Careful (`confirm`, `stop`, `always`, `thorough`, `strict`, `standard`), Balanced (the defaults), and Autopilot (`autonomous`, `resolve`, `when-new`, `proportionate`, `strict`, `brief`). *Checking* exists because some models re-verify facts they already established and gather far more context than the step needs; its `lean` level trades that for speed, and `thorough` asks for it on purpose. Any other combination is shown as Custom.

The user may replace the paragraph of any level. Overrides are stored in `promptOverrides`, a dictionary keyed `<trait>.<level>` (for example `errors.triage`). Empty text, or removing the entry, restores the default. Only the override for the selected level is used, and entries with an unknown key are ignored. The schema accepts only the listed level ids, and the renderer falls back to the trait default for any other value.

The selection is read when an Agent is created and kept for that Agent, so a running Chat's system prompt stays stable and a change applies to new sessions. The preferences change only guidance text. Machine Info approval, Queue purpose gating, Goal opt-in and the host's tool authorization do not depend on them, and no default text grants a risky or destructive action without approval. `followThrough` keeps its original key and values, so existing profiles stay valid.

The values persist in the profile's `cordis.patch.yml` under the `slop-runtime` entry. The "Behavior" tab of the "DSH-SLOP" settings section reads and writes them through the host's settings Remote for the `slop-runtime` namespace with a revision check, and states that a change takes effect in new sessions.

## Goal opt-in

Users create autonomous Goals through the existing Goal control or `/goal <objective>`. Ordinary calculation, repetition, and project-continuation requests do not create Goals. The SLOP adapter hides `create_goal` from each Agent's native and PTC catalogs and rejects any stale or nested invocation at the tool boundary. It replaces upstream's inferred-creation guidance during prompt assembly. No installed upstream package is modified.

The upstream Goal service, command, state, and completion tools remain available. `/goal clear` removes the selected Goal; later ordinary requests cannot recreate it. The user can explicitly create another Goal at any time allowed by upstream state. Editing or resuming an existing Goal still requires an explicit request for that Goal operation.

Queue observes submitted calculations and delivers the configured completion or failure notices. Removing a Goal does not cancel remote work or suppress Queue delivery. Explicitly enabled Goals retain upstream's immediate continuation behavior; SLOP does not add a Goal waiting state or a second scheduler. Avoid using a Goal merely to wait for a long-running process.

For a user-authorized sequence whose later steps depend on an asynchronous job, the Agent selects Queue `purpose: "continue"` with the next authorized step and result locations and resumes the original Chat through upstream follow-up. This continues the existing request without creating a Goal or requiring the user to repeat it. A monitoring-only request declares `purpose: "monitor"` and remains passive. See [Queue delivery](queue.md#chat-delivery).

## Models

SLOP does not select or install a model provider, manage accounts, or prescribe a model. Configure those through the Host. The Queue fallback worker accepts an optional provider, model and reasoning effort through Queue settings; empty values retain the owning Chat's selection.

### Subagent models

DSH 0.2.0-rc.2 lets a parent start a child with an explicit route through `agentOptions` (`provider`, `model`, `reasoningEffort`, `maxTokens`); the in-process `spawn` and `fork` providers and the DSH SDK accept it. DSH's `tool-subagent` row takes `config.agentOptions` as the route for every child of that tool, and `modelSelectionSettings: true` lets the model choose a route for each call from the Host's `subagent-model-selection` preference. Both are user or deployment configuration, normally in the profile's `dsh/profiles/slop/cordis.patch.yml`; SLOP sets neither.

SLOP's own Queue fallback worker has separate Queue settings: `fallbackProvider`, `fallbackModel` and `fallbackReasoningEffort`. See [Queue deterministic checks](queue.md#deterministic-checks).

## Older V0 histories

The upstream V3 converter refuses some early V0 subagent records containing descriptor version 2. SLOP leaves these canonical V0 files unchanged and lets DSH report the refusal when the affected Chat is opened. They are not silently relabeled, truncated, or repaired. Retain the old runtime and the product-home backup if those histories are needed; converting them requires a separate audited migration. See [status](../status.md#known-limits).

## Native Worktrees and optional PTC memory

Standalone profiles include the upstream worktree service and tool. Worktree creation starts from a resolved local commit (HEAD by default), retains the source checkout and does not copy dirty files. The Session's effective execution directory changes, while its immutable original project remains the Knowledge Workspace and Queue ownership anchor. Permission roots do not expand automatically. Installed SLOP plugins leave these upstream capability choices to their Host.

Per-call PTC remains the default. To enable owner-scoped in-memory execution explicitly:

```sh
pnpm start -- --patch /absolute/path/to/packages/web-runtime/ptc-memory.patch.yml
```

This mode retains REPL variables between calls for one owner, not between Chats or Host restarts. Cancellation, timeout or owner release may discard the process. Use REPL syntax rather than top-level `return`; persist important results to files. The patch configures the upstream runtime, and adds no second executor.

## SSH helper assessment

The rc.1 helper can provide native filesystem, subprocess and sandbox services over an existing noninteractive OpenSSH connection. A prebuilt standalone executable removes the remote Node.js prerequisite; the source/script route still requires a matching remote runtime. The inspected rc.1 GitHub release has no helper binary assets.

This is a different execution composition from SLOP's Machine connection. Globally swapping Host filesystem services to a remote provider would also redirect Host-local consumers, including Knowledge. Any pilot must use a separate explicit remote execution scope and retain Machine authorization, host-key checks and protected authentication. No helper is installed, no Machine transport is replaced, and no real-machine pilot is claimed in this upgrade.
