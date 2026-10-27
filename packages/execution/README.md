# @dsh-slop/execution

This package is the host-side implementation of `dsh-slop-machine`.

It resolves saved Machine access profiles, drives system OpenSSH, applies host-trust decisions, carries interactive SSH/2FA through DSH's protected terminal, reuses compatible control masters, exposes `MachineService` for general remote shell execution, and exposes `MachineTransferService` as a thin PTY-backed `scp` wrapper.

`MachineService` accepts an explicit Machine id, command, optional working directory, timeout, and cancellation signal. It resolves current authority revisions, acquires access internally, invokes the command through `sh -lc`, and returns raw bounded stdout/stderr plus exit state. Connection leases and socket references never enter model-visible results.

Profile identity includes the Machine access revision and optional local identity-file path. Passwords, passphrases, OTP values, and protected terminal bytes are never command arguments or Chat text. The package does not otherwise redact shell commands, output, history, paths, or discovery content.

`MachineTransferService` handles Host↔Machine and Host-relayed Machine↔Machine copies without staging payload files. Remote-to-remote calls use `scp -3`; generated per-call SSH aliases bind each endpoint to its existing app-managed ControlMaster socket, and native PTY output remains available to the Chat presentation layer.

This package does not implement schedulers, job submission, monitoring, Artifacts, validation, provenance, transfer orchestration, Workspaces, or scientific analysis. Scheduler commands are ordinary remote shell work directed by the Agent; persistent observation belongs to `@dsh-slop/queue`.

```sh
./node_modules/.bin/tsc -p packages/execution/tsconfig.json --noEmit
./node_modules/.bin/vitest run packages/execution/tests
```
