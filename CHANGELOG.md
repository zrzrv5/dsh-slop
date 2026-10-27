# Release notes

## 0.0.15, first public preview

Targets DeepSeek Harness **0.2.1-rc.3** exactly. An OpenSSH socket directory removed by the OS while the Host keeps running (macOS `/tmp` cleanup, a WSL restart) is now re-created before the next connection instead of failing with `unix_listener: cannot bind to path`.

On Windows, archive components load through paths anchored beside the bundle patch so their dependencies resolve from the installed bundle. Plugin Manager displays those paths as component names.

Agent behavior now covers six preferences instead of one: *Follow-through*, *Errors*, *Before real runs*, *Checking* (how much the Agent re-verifies settled facts and gathers context), *Scope and conventions*, and *Reporting*. Presets set them together (Careful, Balanced, Autopilot), and the prompt text of any level can be edited or reset to its default. The text states that AGENTS.md, CLAUDE.md, Skills and the user's own words take precedence. Changes apply to new sessions only and do not change approvals. Existing `followThrough` values are kept; the other preferences start at the Balanced defaults.

The Queue fallback check worker can run on its own provider, model and reasoning effort through new Queue settings (`fallbackProvider`, `fallbackModel`, `fallbackReasoningEffort`). Empty values keep using the Chat's model, and the Chat and Queue delivery are unaffected.

This release includes Chat-native Machine setup and protected SSH authentication, reusable connections, approved Machine Info, remote shell and Host-relayed transfer; Markdown Knowledge for Home and the current Workspace; and Queue observation of already-submitted work.

This is the first public preview. The installation archive excludes dependency test fixtures, examples and TypeScript build caches, and retains the bundled dependencies' license notices. See [status](docs/status.md) for known limits and outstanding real-system evidence.
