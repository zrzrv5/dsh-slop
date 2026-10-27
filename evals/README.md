# DSH-SLOP evaluations

This directory contains evaluation inputs and harness code. It is not loaded by
the DSH-SLOP runtime, bundled into a Skill, or used to define Tool behavior.

The separation is intentional:

- `packages/`, `skills/`, and `docs/` define the generic Machine, Queue, and
  Knowledge product and the prompts that orchestrate those components.
- `evals/cases/` contains synthetic machine and project scenarios, expected facts,
  scoring rubrics, and performance targets.
- `evals/harness/` reads durable session traces and checks case structure. It
  observes the product; it does not patch prompts or runtime policy for a case.
- Run outputs, raw traces, and local comparison reports remain under ignored
  `artifacts/evals/`.

Run the static and synthetic checks with:

```sh
pnpm eval:check
```

Analyze one recorded DSH turn with:

```sh
node evals/harness/analyze-dsh-trace.mjs /path/to/session.jsonl.zstd
```

Apply a single-turn case's machine-readable safety and efficiency gates with:

```sh
node evals/harness/assert-case-trace.mjs \
  evals/cases/cross-machine-project-reuse \
  /path/to/session.jsonl.zstd
```

For a staged case, name the stage. Consecutive stages may use different turns
from the same trace; a stage marked with another `session` value requires its
own fresh trace.

Pass the stage id after the trace path when running a schema 2 case. The synthetic staged-policy fixture under `harness/fixtures/` exercises stage selection without a live Machine.


This command does not score scientific meaning. The human-readable rubric and
independent reference remain necessary for semantic review.

Live cases are opt-in because they may require an already-authorized Machine
connection. A live run must preserve its prompt, trace, analyzer JSON, Knowledge
receipts, and scored report as separate artifacts.

## Case contract

Schema 1 cases have one prompt. Schema 2 cases contain ordered `stages`; each
stage names its prompt, logical session, turn, component requirements, trace
rules, and thresholds. Every case also has one shared rubric and independent
reference.

- Each prompt is the exact user message the Agent receives at that stage.
- The reference records independently observed facts and known unknowns.
- The rubric defines correctness, safety, component use, and efficiency.
- The manifest names those files and provides machine-readable thresholds.

The reference is not injected into the Agent. A scorer compares the trace and
durable output against it after the run.
