# Root selection

Call slop_machine_get first so the Host can verify the Machine, connection, and declared roots for this turn.
For a supplied root needing resolution, call slop_machine_shell with machineId, timeoutMs at most 20000, and discovery `{phase: "resolve-root", root, purpose}`, omitting command and workdir.
Reuse the returned absolute root; ask for a root only when neither the request nor the Machine establishes one.

For the census, call slop_machine_shell with machineId, the exact root as workdir, timeoutMs at most 20000, and discovery `{phase: "census", root, purpose}`, omitting command and evidenceFiles.
The Host builds the bounded depth-one census and returns value.censusPage with entries initially unclassified and a completeness flag.
An empty entries array is valid; complete=false means the page reached its cap and cannot establish the full root inventory.
Use the returned entries directly instead of writing a census parser or retyping every row into a second program.

Select the smallest project set needed by the user, using names, notes, existing Knowledge, and relevant Queue activity as selection clues rather than proof of file contents.
An exact declared project can proceed directly to project reads without a root census.
Keep the ordered selectionPlan stable throughout this discovery turn.

Scheduler history is optional when it can resolve a specific selection or operating question; use Queue first and start with a short history interval, normally seven days.
Scope scheduler queries to the current user, aggregate remotely, omit job IDs from inventory evidence, and limit output to 64 rows before any sorting.
An output cap does not justify querying a year of history for a recent-work question.
