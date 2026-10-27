# Project evidence

Use slop_machine_shell with machineId, exact projectPath as workdir, timeoutMs at most 20000, and discovery `{phase: "project-read", projectPath, purpose, selectionPlan}`.
Omit command and evidenceFiles for the initial project page; the Host generates bounded candidates from root files and a small set of workstreams.
Inspect the returned candidates before selecting files.
When an observed workstream lacks useful candidates, add its exact relative path (for example ./source, never an absolute path) as discovery.focus and omit command and evidenceFiles for a focused page.

Read up to six selected small text files through evidenceFiles, omitting command; select fewer when they suffice.
Each path must have appeared in that project's earlier output or in a returned file's exact reference.
An absolute shared-file reference is allowed only when observed in this project and contained by a declared root on the same Machine.
Do not guess a sibling path, conventional filename, or cross-Machine binding.
The Host quotes and compiles these reads and returns FILE and EVIDENCE records; use evidenceTerms only for exact literal terms already returned when a focused follow-up is needed.

Establish what the project does and the execution path relevant to the request, including analysis code when the task involves interpreting results.
Use exact observed source files and lines for direct edges, and mark an edge partial when its invocation, referenced file, or required behavior remains unknown.
A name, import, configuration object, or launch wrapper alone does not establish the complete worker workflow.
Shell comments are inactive commands, while scheduler directives such as #SBATCH and #PBS can establish scheduler configuration under their scheduler's parsing rules.
The guard checks provenance and structural evidence; it does not prove scientific meaning or successful execution.

Machine tools return `{ok, value}`: require ok, check value.discoveryControl, then exitCode and timedOut before using stdout as successful evidence.
A discoveryControl result performs no new remote work; reuse prior evidence, remove unobserved paths when offered, and do not replay successful siblings.
Treat clipped lines and incomplete pages as partial evidence, then read only the specific missing content when it matters.
