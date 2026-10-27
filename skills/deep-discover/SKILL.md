---
name: deep-discover
description: Use for an explicit broad Machine or multi-project inventory request; use project-work for ordinary work on a named project.
---

# Deep discovery

Resolve the requested saved Machine with slop_machine_list. If it is ambiguous, ask the user to select one; do not discover every Machine by default.

Read the selected Machine and reuse ready access; any permitted SSH authentication belongs in the protected Machine card.
Honor an explicit existing-connection-only constraint.
Resolve a user-supplied home-relative root through the shell's resolve-root phase without requiring a preliminary Machine Info save.

Retrieve only missing Knowledge context and relevant Queue state, reusing results already available for this task.
Read one relevant Knowledge page per Code Mode program, normally at most 8 KiB, within the 12 KiB outer result limit.
Knowledge supplies prior understanding; Machine Info supplies approved operating facts; files and Queue establish their current contents and observations.

Use the references below only for the next needed stage, resolving them from this Skill's returned resource base:

- Read references/root-census.md to choose projects from a declared root.
- Read references/project-evidence.md to inspect selected projects.
- Read references/project-repair.md only when an unresolved edge affects the requested answer.
- Read references/preserve.md only when useful new understanding needs persistence.

The Host bounds discovery to 32 shell attempts, twelve selected projects, five calls per project, and 12 KiB per result within 256 KiB per turn; these are ceilings, not targets.
Run dependent reads sequentially and return their bounded results before selecting new paths.
Treat names and prior Knowledge as candidate evidence, leaving unread entries unclassified with census provenance.
Do not execute discovered scripts or environment setup, mutate files or jobs, or read secrets, licensed inputs, trajectories, checkpoints, archives, or raw scientific results during discovery.

Repair a recoverable failure only when a specific correction can answer the remaining question within the host budget; reuse accepted evidence and never repeat an uncertain write.
If the guard stops discovery, report supported findings and the unresolved fact instead of trying another tool to bypass it.
Report new or changed operating facts as a complete Machine Info proposal and obtain the required approval before saving it.
An unchanged inventory needs findings and unknowns, not another Machine Info proposal or Knowledge rewrite.
