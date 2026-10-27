---
name: project-work
description: Use for ordinary work on an identified project, including running, reproducing, analyzing, or adapting its existing workflow.
---

# Project work

Load a relevant installed domain Skill when the task needs its method, and use Machine Info, Knowledge, Queue, and current files only for the facts each source establishes.

Search Knowledge once for unresolved project context, deduplicate by docRef, and read only relevant bounded pages through the Knowledge tools.

For recent or submitted work, check Queue before scheduler history; an empty ledger does not establish that no external job exists.

Read the selected Machine and verify its operating bindings before using remote paths or adapting a workflow from another Machine.

Start at the named project and its existing workflow on the Machines the user identified; broaden only to resolve a specific missing fact.

If the project path is unknown, inspect one bounded page of the declared root’s direct children, then choose a relevant subtree before searching deeper.

Bound traversal and returned bytes before sorting, and narrow after a timeout instead of repeating a scan across sibling projects.

Choose the simplest adequate tool: native file reads for local text, shallow `find` for remote paths, and bounded `head`, `sed`, `tail`, or `rg` for text. Use Python for structured data, scientific libraries, or transformations that need it, not as a default wrapper for listings and log reads.

The same scope, depth, file-count, and byte limits apply in every language. Prune traversal before descent and stop collecting at the candidate cap; slicing after `os.walk`, `rglob`, sorting, or `read_text()` does not bound the work. Unknown paths start at depth one; increase depth only inside a selected subtree for a stated missing fact.

Inspect at most three candidate files initially, with at most the first 100 lines or 8 KiB per file and 12 KiB total per returned result.

Then read the exact functions, configuration sections, or active commands needed for the decision; a head or truncated result does not establish the whole file’s behavior.

When reusing or adapting a workflow, read references/reuse.md before writing files. Inspect its entry point, driver, inputs and analysis scripts, and identify the necessary changes.

Make the smallest authorized adaptation, run the checks needed for the requested result, and stop when those checks and the requested work are complete.

Use references/transfer.md only for a file transfer, and preserve existing files and partial data throughout the operation.

For an explicit project-identity correction, read references/identity-correction.md and reuse existing evidence before gathering new remote facts.

Persist only a useful reusable delta through the Knowledge tools, retain required privacy and digest safeguards, and report each successful write receipt.

Track accepted submissions with Queue and report meaningful changes without repeated healthy checks or extra work added solely to fill waiting time.

If an asynchronous job blocks later steps already requested by the user, load `queue-tracking` and register `purpose: "continue"` with the authorized next step and result paths in `continuation` before ending the turn. Verify the returned settings; a pending Todo or notes alone cannot resume an idle Chat. Resume only the authorized steps, checking existing submission receipts first.

For a stale tracked status, use `slop_queue_update` with `check-now` instead of writing a scheduler parser. Filter Queue lists by the relevant Machine, state, or current Chat and request only the rows needed.

To show a plot, transfer a remote image into the current Host Workspace and embed its absolute Host path as `![description](/absolute/path/plot.png)`. DSH Web renders it after the reply finishes. Use native `read_image` when inspecting the image; a remote filesystem path is not a browser image URL.

Load complete applicable Skill instructions; the head-first limits above apply to project files and logs.
