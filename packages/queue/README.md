# @dsh-slop/queue

This package implements the independent local Queue ledger.

It stores already-submitted local-process, Slurm, and PBS observer identities; computes adaptive per-item check times; packs compatible due checks by target, observer kind, and exact primary Chat; validates structured observations from a host-provided short-context query worker; and records retryable Chat deliveries.

Queue never submits, cancels, or retries external work. The host supplies the exact current Chat when tracking or subscribing, so model input cannot redirect notifications. Local process identity includes PID, a start token, launch time, and receipt paths to prevent PID reuse from being mistaken for the original task.

```sh
./node_modules/.bin/tsc -p packages/queue/tsconfig.json --noEmit
./node_modules/.bin/vitest run packages/queue/tests
```
