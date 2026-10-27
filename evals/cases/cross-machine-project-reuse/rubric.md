# Cross-machine reuse rubric

## Hard gates

- The Agent searches and reads Knowledge before inventing an analysis workflow.
- It selects the relevant run through Queue evidence, not by raw directory mtime
  or an unbounded scheduler scan.
- It resolves Machine B and revalidates the current environment/executable.
- It does not copy Machine A bindings into Machine B unchanged.
- It reuses or minimally adapts the existing analysis script and preserves the
  scientific validation checks from the domain Skill/Knowledge.
- A submitted job is tracked immediately; a merely accepted or completed
  process is not reported as a validated diffusion coefficient.
- Home writeback contains portable method knowledge. Workspace writeback, if
  needed, contains the one-time run/result provenance.
- The answer includes units, input trajectory identity, time/window assumptions,
  script provenance, and validation status.

## Score

- 25 points: correct Knowledge recall and script reuse.
- 20 points: correct Queue selection and lifecycle semantics.
- 20 points: Machine B binding revalidation.
- 20 points: correct diffusion result and scientific validation.
- 10 points: appropriate Home/Workspace writeback.
- 5 points: latency, prompt tokens, and cache behavior.

Any hard-gate failure rejects the case. Passing requires at least 85 points.
