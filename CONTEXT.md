# DSH-SLOP context

This file fixes the product vocabulary used by the README, documentation, Skills, UI, and model tools.

SLOP stands for Scientific Lab Operations Plugin. DSH-SLOP is a Chat-first Machine, Knowledge, and Queue layer over the upstream DSH harness. Machine answers where and how work can run. Knowledge preserves reusable written understanding. Queue watches work that an Agent has already submitted.

## Glossary

| Term | Meaning |
| --- | --- |
| Agent | An upstream DSH Standard or Code Agent working in a Chat. DSH-SLOP does not create a separate Agent lifecycle. |
| Chat | The upstream conversation and ordinary trace containing messages, tool calls, results, and typed cards. |
| Host | The computer and OS principal running DSH-SLOP. Knowledge reuse between Agents is guaranteed only when they use the same Host and principal. |
| Machine | A local or remote compute target with explicit connection and access state. A Machine may be mentioned in Markdown, but it is never a Knowledge scope, filter, or header field. |
| Machine Info | Approved, Machine-specific operational facts such as scheduler setup, accounts, executable and module choices, environment setup, filesystem roots, and paths. |
| Official Workspace | The exact Workspace supplied by upstream DSH for the current Chat. It is not inferred from an arbitrary current directory, repository guess, recent path, or Machine project path. |
| Home Knowledge | Systematic Markdown knowledge intended for reuse across Workspaces on the same Host. Its configurable Host-local root defaults to `~/.slop/knowledge`. |
| Workspace Knowledge | Persistent Markdown knowledge under `<Workspace.path>/.dsh/knowledge` on the Host. It holds finer, temporary, one-time, or not-yet-systematic understanding for that official Workspace. |
| Knowledge item | One Markdown file inside Home Knowledge or the current Workspace Knowledge directory. The file is the sole authority for its content. |
| Document reference | The opaque `docRef` returned by Knowledge search and accepted by Knowledge read. It resolves only within Home and the current official Workspace available to that Chat. |
| Relative path | The normalized `.md` path inside a Knowledge root. Knowledge write accepts it as `path`; receipts return it as `relativePath`. |
| Digest | An opaque content hash of the exact Markdown bytes. Knowledge update checks it immediately before atomic replacement and returns it in the write receipt. |
| Derived index | Rebuildable search data extracted from Markdown. It can accelerate retrieval but cannot create, replace, or repair authoritative content. |
| Referenced file | A script, input, result, or other file linked from Markdown, including a safe Machine/path reference. The original filesystem remains authoritative; Knowledge does not copy, execute, sync, or take ownership of it. |
| Queue item | A durable observation record for work submitted outside Queue. It is not a result, Artifact, or Knowledge item. |
| Prefix cache | Reuse of computation for an identical model-input prefix. It does not remove those tokens from the model context window. |
| Model context | The finite input visible to the model in the current turn. Search results and read Markdown consume it when returned. |

## Fixed boundaries

- Knowledge search reads Home plus the current official Workspace only. It never searches other Workspaces.
- Agents on the same Host can reuse the same Home Knowledge and, when they share the official Workspace, the same Workspace Knowledge. DSH-SLOP does not promise cross-Host synchronization.
- Home and Workspace are separate candidate sources. They do not merge fields or silently overwrite one another.
- An Agent may automatically create or perform a digest-guarded Knowledge update and must report the resulting mode, scope, `docRef`, `relativePath`, and digest in Chat.
- DSH-SLOP exposes no Knowledge delete, rename, or conflict-overwrite operation.
- Machine Info is authoritative for connection state and approved current Machine operating facts. Knowledge may mention a Machine or path as provenance or a reusable reference, but that text creates no Machine scope and must be checked again at use time.
- Knowledge can cite existing scripts and results, but native filesystem and shell facilities remain responsible for reading, changing, and running them.
- No Knowledge catalog is injected into every turn. Agents explicitly search, then read only selected items.
