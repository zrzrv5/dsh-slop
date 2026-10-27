# Project work

Machine, Knowledge, and Queue remain independent authorities. The Agent combines them in ordinary Chat when it starts, continues, reproduces, or analyzes project work.

This workflow is prompt-driven. DSH-SLOP ships the `project-work` Skill and stable Tool descriptions. It does not add a workflow database, project schema, hidden current Machine, or dedicated Deep Discovery service.

## Normal sequence

1. Load the relevant user-installed domain Skill when one exists. It explains the general scientific or technical method.
2. Search Home and current Workspace Knowledge for prior project practice, existing scripts, analysis methods, and user corrections.
3. Read Queue when the request concerns work that may already be submitted or completed.
4. Read the selected Machine before relying on remote operational facts. Verify referenced files and current provider state only where needed.
5. Reuse or minimally adapt existing scripts and configurations. Submit through native local or Machine shell facilities.
6. Track a successful submission in Queue using the exact provider receipt.
7. Validate the actual result, then preserve useful new understanding in Home or Workspace Knowledge.

The sequence is adaptive. A local analysis may need Knowledge and Workspace files but no Machine. A new remote calculation may need all three components. An untracked historical job may require a bounded scheduler query because Queue cannot contain work it never recorded.

## Source responsibilities

| Source | What it establishes |
| --- | --- |
| User request | The current goal and constraints |
| Domain Skill | General method and software practice |
| Knowledge | Prior user and project understanding |
| Machine Info | Approved current operating facts for one Machine |
| Queue | Tracked submission state and observation history |
| Files and provider output | Current script, configuration, job, and result evidence |

Knowledge from one Machine may guide work on another. The Agent keeps the reusable method and resolves a new operational binding from the target Machine. It does not copy the old Machine's module, executable, filesystem root, account, partition, or resource choice without checking.

## Reuse and evidence

A path or filename is a candidate, not proof of what a script does. Before execution, the Agent reads enough of the selected branch to identify the outer wrapper, its immediate driver, referenced environment or resource configuration, and worker command when those details affect correctness.

For a named project, inspect its exact known paths before searching other projects. If the user names multiple Machines as sources, check that project's existing workflow on those Machines first. Resolve an unknown project path with one shallow page of the declared root. Do not recursively scan an entire Home, Work, or Scratch root for an ordinary project task. Sorting and truncating output does not bound the traversal that produced it.

Initial project-file reads cover at most 100 lines and 8 KiB per file, with at most three candidates and 12 KiB total per returned result. Follow relevant references and use targeted later ranges when the head does not establish the needed behavior. Read the full file only when it fits those bounds or the current decision requires it. These limits do not replace loading complete applicable Skill instructions.

These limits apply to shell utilities and Python alike. Prefer native local reads and bounded remote text commands for routine inspection; use Python when structured data, scientific libraries, or a transformation justifies it. Prune before descent and cap candidates before sorting. Reading an entire file with `read_text()` and then slicing its lines does not bound the read. Start unknown-root discovery at depth one and deepen only inside a selected subtree for a specific unresolved fact.

Every remote-shell canonical result is capped at 12 KiB, including PTC results. Oversized ordinary output preserves the exit status and returns an explicit truncated preview; the command has already run, so a mutation must not be repeated to recover its output. This output boundary does not mechanically restrict filesystem traversal inside arbitrary programs. Project traversal remains a Skill contract; explicit Machine discovery additionally uses the Host's guarded commands.

Before drafting a replacement, identify the existing execution and analysis scripts and explain the necessary adaptations in the normal plan. A new output directory does not imply a new implementation. A truncated listing or a missing filename match does not establish that no existing workflow exists.

Use the old wrapper, driver, configuration and input layout as the baseline. Name the old and new entry points and make the smallest changes required by the request or verified target-machine constraints. New CLI options, batch limits or directory hierarchies need a concrete reason and an explicit account of their effect on scope. Preparing a first batch does not complete a request for the full dataset.

Before presenting work for submission approval, prepare the authorized wrapper and required inputs and validate the actual invocation from that wrapper through the driver and configuration. Check input locations and selected task count against the request, and identify any intentional external dependencies. A driver-only check does not prove the submission directory is complete. Review-before-submit permits preparation and prohibits submission until approval; it does not defer preparing the submission files.

The editing Agent reads the relevant original source even when a subagent located it. Preserve the full task set, explicit group size and walltime, established dispatcher, working directory and logs. A submission report identifies the provider receipt, command, work directory and stdout/stderr paths. Callback integration is optional observation and cannot justify changing that workflow.

Validation exercises the installed production generator and its generated inputs, not a custom approximation of its replacements. For an already authorized run, diagnosis is followed by the necessary repair, validation and continuation; the Agent does not ask the user to repeat that authorization. Before retrying it checks existing effects and job receipts. A new material decision, uncertain side effects or a repeated unexplained failure justifies stopping; generic task caps, command timeouts and immutable config guards are not substitutes for evidence.

The Agent may store concrete commands and paths in Markdown because they make prior work reproducible and remain easy for the user to edit. Such facts are provenance. Their current validity comes from the referenced file or Machine, not from Knowledge.

Queue completion means the process ended. It does not prove the scientific result is correct. Result interpretation remains native Agent work guided by the domain Skill and actual output.

## Images in Chat

The pinned DSH Web Chat already renders images in completed assistant Markdown. Embed an absolute Host-local image path with `![description](/absolute/path/plot.png)`; Chat resolves it through the same-origin file route. Relative paths and remote Machine paths do not identify Host files. Transfer a remote plot into the current Host Workspace first. Local-path images settle after streaming finishes, and failed loads fall back to alt text.

Use upstream `read_image` to inspect a supported image with an image-capable model; upstream attachment presentation also displays its tool-result image. Ordinary plots need no additional Artifact plugin or ad hoc image server. This uses upstream capabilities and does not add an Artifact authority to SLOP.

## Context cost

The product does not inject a Knowledge catalog or recent items into every request. Stable Skill and Tool text can remain prefix-cache friendly. Project-specific Knowledge, Machine records, Queue items, and files enter context only after bounded calls select them.

Code Mode batches only bounded independent work that fits the outer result limit. Knowledge reads return one relevant page per program, normally at most 8 KiB within 12 KiB total, and reuse pages already returned for the same docRef. Follow nextByteOffset or an exact availableHeadingPaths value instead of reading spilled Knowledge through generic file tools. Do not batch across a decision that depends on unseen search results, directory contents, or scientific evidence.

Once a stage is submitted, Queue observes it. If it blocks later steps already authorized by the user, the Agent selects and verifies terminal-state `wake` delivery before ending the turn; the follow-up resumes those steps after checking evidence and prior submission receipts. Ordinary monitoring retains passive notification. The Agent does not repeatedly probe healthy processes or add optional scripts merely to fill time before completion. This event-driven continuation requires no Goal; autonomous Goal creation still requires explicit user opt-in as described in [runtime](runtime.md#goal-opt-in).

## Validation separation

Core tests verify Tool composition, authority separation, prompt contracts, bounded results, and lifecycle behavior. Concrete clusters, project names, directory counts, candidate files, expected scientific facts, timing budgets, and scoring rubrics belong to external evaluation cases. A failed evaluation may reveal a general rule worth adding here, but its expected answer never becomes product prompt text or a runtime guard condition.
