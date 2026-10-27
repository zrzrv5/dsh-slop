# Adapt an existing workflow

Use the existing files as the baseline. Read the outer submission wrapper, its immediate driver, referenced configuration and required inputs, and the relevant analysis or collection scripts. Follow references until the execution path is understood; summaries help locate files but do not replace reading the sections being changed.

If a subagent found the reference, the editing agent still reads the relevant original code and invocation. A prose summary or line range is a locator, not a replacement for source evidence.

Before writing, state the old entry point, the new entry point, and the necessary differences. Preserve the established invocation, directory layout and task selection unless the requested result or a verified target-machine constraint requires a change. Copy and minimally edit the relevant files when practical. Resolve machine paths, accounts, environments and worker commands on the actual target; retain the project's scientific settings except for requested changes.

Do not introduce a new CLI, batch cap, directory hierarchy or submission interface merely because the output directory is new. If scale requires a changed execution strategy, explain its reason and its effect on the requested scope. A first batch is not the whole requested dataset. Existing CLI options may remain when the wrapper already uses them.

Submit the full requested task set through the existing dispatcher in one invocation unless the user requests splitting or a verified scheduler limit requires it. Preserve explicit group size and walltime. Do not add arbitrary task timeouts, immutable configuration hashes or extra overwrite approvals as generic precautions; preserve recoverable originals and make the requested edits.

Keep the established working directory and log locations. Report the accepted job id, exact submission command, work directory, stdout and stderr paths. If an authorized adaptation changes a path, state the new path when reporting submission.

Prepare all authorized files needed for review, including the wrapper and required input directory. Reuse or copy user-owned inputs according to the established layout; verify their source and destination without exposing licensed contents or secrets. If an input must remain an external reference, state that dependency rather than presenting the directory as self-contained. A request to review before submission does not defer preparing the submission files.

Validate from the actual entry point: wrapper syntax and working directory, interpreter/environment, driver arguments, configuration paths, required inputs, and selected task count. Use the workflow's non-submitting checks where available. Compare the final invocation, file tree and scope with the baseline and the request. A driver-only check cannot establish wrapper readiness. Report concrete missing inputs or unverified runtime behavior instead of marking preparation complete.

Test the generated inputs and command produced by the actual installed workflow. A custom renderer, regex substitution or hand-built invocation does not validate a different production generator. For a failed authorized run, diagnose, make the necessary correction, validate it and resume within that request. Do not stop after diagnosis or seek the same authorization again. Check receipts and active jobs before retrying; stop for a new material decision, uncertain side effects or a repeated unexplained failure.
