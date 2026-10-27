# @dsh-slop/plugin

This package composes the independent Machine and Queue capabilities into DSH.

It registers the exact fourteen model tools documented at the repository root, the `/setupmachine` Chat command, Machine browser remotes, the authority event feed, the protected SSH authentication carrier, transfer-progress relay, and the Queue monitor. Provider account settings remain provider-owned.

The plugin uses the current DSH Agent and Chat. Setup submission does not create an Agent or product run. Queue query work uses a fresh short-context DSH child under the exact owning Chat, and Queue delivery resumes or notifies only captured Chat targets.

Protected authentication bytes stay on `/dsh-slop/auth`. Ordinary setup fields, Machine Info, remote commands, shell output, and Queue evidence use normal Chat/tool paths and are not content-redacted by the plugin.

The plugin does not contain product personas or model tools for analysis, validation, Artifacts, provenance, Workspaces, submission, cancellation, or retry. Upstream Standard and Code presets provide native harness capabilities.

```sh
./node_modules/.bin/tsc -p packages/plugin/tsconfig.check.json
./node_modules/.bin/vitest run packages/plugin/tests
```
