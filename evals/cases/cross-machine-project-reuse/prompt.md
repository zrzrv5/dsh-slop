# Cross-machine project reuse

The current Workspace is on Machine B. Compute the diffusion coefficient for
the most recent completed trajectory in this project.

Use installed domain Skills for the scientific method. Use SLOP Knowledge to
find whether this analysis or a close variant was previously performed,
including work first observed on another Machine. Use Queue to identify the
relevant tracked run and its current evidence before reading raw scheduler
history. Use Machine to resolve the current execution environment.

Prefer an existing verified analysis script over rewriting it. Adapt only the
machine-specific bindings that differ on Machine B, and state what you
revalidated. Do not treat a previous Machine A path, module, executable, or
scheduler resource as valid on Machine B without current evidence.

If the calculation can be completed read-only, report the result provenance and
the reused script. If it requires a new submission, prepare the submission,
track the accepted job in Queue immediately, and do not claim a scientific
result before output validation. Write reusable corrections to Home Knowledge
and one-time run details to Workspace Knowledge.
