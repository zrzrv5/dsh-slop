# Knowledge

Knowledge gives an Agent durable Markdown it can search when needed, so it does not re-read every project directory or carry a catalog in every turn. It stores reusable understanding: how an analysis was set up, which script is canonical, what a correction taught. It is not transcript memory, a result database or a job ledger.

If you prefer another memory plugin, turn Knowledge off in Plugin Manager. The files are plain Markdown, so other tools can read and write the same directories.

## Two scopes

| Scope | Location | For |
| --- | --- | --- |
| **Home** | `~/.slop/knowledge` (changeable in Settings) | Methods and conventions useful across projects on this computer |
| **Workspace** | `.dsh/knowledge` inside the current DSH Workspace | Finer, provisional or one-time understanding for that Workspace |

Every search covers Home plus the current Workspace and nothing else. The Agent cannot point it at another Workspace or an arbitrary directory. A machine is not a scope: a note may mention a machine or path, but the Agent checks it against current [Machine Info](machine.md#machine-info) before relying on it.

Nothing is synchronized between computers. You may point Home at a directory you sync yourself; that tool then owns availability and conflicts.

## How the Agent uses it

- `slop_knowledge_search` returns a bounded list of candidates, Home and Workspace kept separate, with snippets. Nothing is injected unless the Agent searches.
- `slop_knowledge_read` returns the current Markdown of one item and its digest, in pages of 8 KiB by default (64 KiB at most), optionally limited to one heading.
- `slop_knowledge_write` creates a new item, or updates one using the digest from the latest read. A stale or missing digest fails without writing. Updates can replace named sections instead of resending a whole document. The Agent reports each write's scope, path and digest in Chat.

There is no tool to delete, rename or overwrite. You can always edit the files yourself.

## Note format

```markdown
---
name: run-eos-analysis
description: Reuse an equation-of-state calculation pattern when preparing or adapting EOS work.
tags: [eos, equation-of-state]
---

Body in ordinary Markdown.
```

`name` and `description` are required for notes the Agent writes; `tags` is optional. Files without a header are still searchable. An index speeds up search, but the files are the only authority and the index can be rebuilt at any time.

## Safety

A note is reference material, never an instruction that overrides you, a Skill or an approval. The Agent must not write passwords, tokens, private keys or licensed file contents into a note, and Home notes are visible to every Agent on this computer, so it keeps them general. Paths are restricted to the Knowledge roots: absolute paths, `..` and symlink escapes are rejected.

Full contract: [internals/knowledge.md](internals/knowledge.md).
