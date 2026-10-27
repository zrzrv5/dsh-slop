# `@dsh-slop/knowledge`

Cordis plugin and `ctx.slopKnowledge` service for bounded, local Markdown knowledge.

Markdown is the only authority. The in-memory SQLite FTS5 database is a disposable search cache rebuilt from files. The plugin searches two sources for an agent:

- Home: `<DSH Host account home>/.slop/knowledge` by default
- Current Workspace: `<Workspace.path>/.dsh/knowledge`, only after resolving `agent.session.header.cwd` through `workspaceRegistry.resolveByPath`

It never searches every registered Workspace for a tool call. Settings status and rebuild operations list every registered Workspace with global scan budgets.

## Markdown contract

Existing user-authored `.md` files do not need frontmatter. Missing metadata falls back to the first H1 or file name and the first paragraph. Known frontmatter fields are `name`, `description`, and optional `tags`; unknown keys are ignored by indexing and excluded from searchable body text.

Agent-created files require frontmatter with a lowercase hyphenated `name` slug, a non-empty `description`, and optional non-empty string `tags`. Create rejects unknown frontmatter keys. Update accepts existing headerless files and requires unknown frontmatter values to remain unchanged.

## Tools

- `slop_knowledge_search` synchronizes Home and the current Workspace before bounded retrieval.
- `slop_knowledge_read` accepts an opaque `docRef`, optional heading, and UTF-8 byte pagination. A page is at most 64 KiB. It also returns a bounded list of exact heading paths for section updates.
- `slop_knowledge_write` has distinct `create` and `update` modes. Create fails when the path exists. Update requires the latest digest from a read or write receipt and fails on mismatch. The compatible full-document update remains available. `operation: replace-sections` replaces up to 32 uniquely selected Markdown section bodies in one atomic update. A heading selector accepts either title text or a complete Markdown heading line. Each replacement accepts either `body` or the line-array `bodyLines` form, which the Host joins with newlines. Generated free Markdown in Code Mode uses the bundled comment-block transport so its prose is not parsed as JavaScript string syntax. Replacement bodies total at most 64 KiB and the final document remains at most 1 MiB.

There are no delete, rename, upsert, or conflict-overwrite operations. Tool results label document-derived values as untrusted data and enforce a 96 KiB serialized rendering limit.

Section replacement selectors use the complete heading ancestry from H1 through the target heading. The `body` starts after the existing target heading line, so it must not repeat that line. The write rejects missing or ambiguous paths, duplicate targets, and ancestor/descendant overlap. It preserves every byte outside the selected section bodies, including frontmatter.
