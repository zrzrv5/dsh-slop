# Upstream baseline

## Current pin

- Repository: `https://github.com/deepseek-ai/deepseek-harness.git`
- Release: `dsh-v0.2.1-rc.3`
- Commit: `1f81c047fc48fa190a683e469daa699857e9afe8`
- Verified: 2026-10-26

The tag was verified against GitHub and the published npm packages. Session format remains V4. `0.2.1-rc.4` is published on npm but has no GitHub tag; its npm packages differ from rc.3 only in `dsh-client-ui-conversation` View-tab tooltips and `dsh-mcp-client`/`dsh-mcp-resources` handling of servers without resources. It is not adopted.

## Changes adopted

- rc.3 needs no source changes beyond the rc.1 adaptation below; the subagent, tool-restriction and web-startup contracts SLOP uses are unchanged from rc.1.
- Replace `webRuntime` with public `webStartup.trustedHosts`; consume named JSONL persistence exports.
- Queue fallback uses managed `startActivation` with caller delivery and dedicated restricted presets. Queue owns cancellation after publication and releases the exact activation. The child's own `structured_output` registration stays outside the preset's tool restriction.
- Standalone composition adds upstream Worktrees and Plugin Market, and leaves directory-picker selection to upstream's automatic provider.
- Optional persistent PTC memory is supplied as an explicit patch; per-call execution remains the default.
- Plugin archives name components by paths anchored beside the bundle patch. Bare names install live on Linux, but on Windows they resolve to native real paths that can miss the profile layer, so the components' own `@deepseek-ai/cordis` imports fail. The archive declares exact `engines.dsh` compatibility.

## Dependency policy

DSH-SLOP stays out of tree. It consumes the exact matching set of public `@deepseek-ai/dsh-*` packages and contributes an installable bundle, a standalone profile, agent presets, Skills and client modules. It must not edit upstream packages, vendor selected upstream source files, or depend on undocumented source paths.

Because DSH is a developer preview with explicit compatibility-breaking changes, all DSH packages use one exact version. No caret, tilde, `next`, `master` or floating Git reference is allowed in a release lockfile. Version-scoped `packageExtensions` in `pnpm-workspace.yaml` supply imports that a published upstream package forgot to declare; they do not edit upstream code.

## Upgrade procedure

1. Immediately before implementation begins and before every release, fetch upstream tags and packages and identify the intended exact tag and commit. If a newer release exists, do not keep calling this pin "latest": either run this upgrade review first or record explicit approval to stay on the older target.
2. Read upstream architecture, migration notes, package manifests, client slot contracts, preset examples and persistence format changes.
3. Update the compatibility fixture (`tests/fixtures/upstream-release.json`) and all DSH package pins together on a dedicated branch.
4. Build from a clean checkout and run composition, preset-mount, client-module, migration, restart-recovery and end-to-end acceptance tests.
5. Record behavior changes and the new exact commit here.
6. Merge only when the complete product passes. Do not carry compatibility shims for an unshipped upstream format unless real user data requires a migration.

Community packages may be studied or adopted only after review of source, license, release pin, threat model, maintenance and compatibility. See [runtime](docs/internals/runtime.md) for the boundary between SLOP and external runtime configuration.

## Validation

See [status](docs/status.md) for candidate checks and outstanding real-system evidence. Repository checks do not validate an operator's deployment, accounts or historical data.

## Native Windows SSH dependency

Machine pins the MIT-licensed [`ssh2` 1.17.0](https://github.com/mscdex/ssh2/releases/tag/v1.17.0), tag commit `844f1edfc41589737671f96a4f4e76afdf46abd4`, with development-only `@types/ssh2` 1.15.6. The published client, agent, host-verification, exec and SFTP APIs were reviewed against that installed release. This is a Machine transport dependency; it adds no personal provider or credentials to core.

The archive bundles its installed JavaScript runtime and required dependency graph with original licenses, removing generated-package lifecycle scripts, dependency test/example fixtures, TypeScript build caches and optional native addons. This avoids Harness's strict build-script approval gate and keeps Windows installation independent of compilers and WSL. The SSH library handles protocol cryptography; SLOP owns explicit host-key approval, owner-scoped protected prompts, profile-revision checks and connection lifetime. Algorithm negotiation intersects the resolved OpenSSH policy with supported modern algorithms. Unsupported proxy, certificate and hardware-key configuration fails explicitly instead of silently connecting directly.

A repository-wide dependency audit is not clean: existing transitive dependencies have advisories. The SSH runtime graph had none in that audit, which is not a claim that the library or Host is vulnerability-free.
