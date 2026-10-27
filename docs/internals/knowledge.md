# Knowledge

## Purpose

Knowledge gives Agents durable Markdown they can retrieve without rereading every project directory or carrying a catalog in every Chat turn. It records reusable understanding. It is not a hidden transcript memory, workflow engine, Artifact store, result database, Machine registry, or job ledger.

Knowledge has two scopes:

- **Home Knowledge** contains systematic methods and conventions that should be useful across Workspaces on this Host.
- **Workspace Knowledge** contains persistent but finer, temporary, one-time, or not-yet-systematic understanding for the current official DSH Workspace.

A Machine is not a Knowledge scope, search filter, or header field. A Markdown body may name a Machine, path, scheduler, software, or prior command when that reference helps future work. The Agent verifies the referenced file and current operating facts against the selected Machine and Machine Info before reuse.

## Scope and reuse

Every search uses the Home root plus the current official Workspace root. It never searches Knowledge belonging to another Workspace. The host supplies the official Workspace from Chat context; model input cannot nominate another Workspace or turn an arbitrary directory into one.

Home Knowledge is reusable by Agents working in different Workspaces on the same Host and OS principal. Workspace Knowledge is reusable by Agents and Chats attached to that same official Workspace. When no official Workspace exists, Home remains available and Workspace search or writes are unavailable.

Cross-Workspace reuse therefore requires a Home item. Turning useful Workspace material into Home Knowledge creates or updates a separate, systematic Home Markdown file. The Agent removes irrelevant one-off details, secrets, and unsupported conclusions instead of copying the Workspace note verbatim. It may keep a Machine or path reference when it is useful provenance and clearly requires runtime verification. The original Workspace file remains unchanged.

Knowledge can also name one logical project that spans several physical roots, Machines, or prior Workspaces. This remains ordinary Markdown rather than a new project schema: `name` supplies the stable human-chosen identity, `description` and optional `tags` carry aliases for retrieval, and the body records constituent roots, their relationship, shared methods, differences, and provenance. A user-defined item may group several existing calculation and analysis roots without changing those directories or inventing Machine/project frontmatter. Put a settled cross-Workspace identity in Home; keep an exploratory grouping in the current Workspace.

This grouping is semantic, not a filesystem merge, Workspace merge, or ownership transfer. Creating it does not delete, rename, shadow, or silently combine existing Knowledge items. When existing items overlap, the Agent links them and explains the relationship; later consolidation still follows explicit read plus digest-guarded update.

The Agent does not infer a logical grouping merely because two roots use similar software or workflows. Discovery reports the physical projects it can establish and leaves their relationship open for review. When the user later groups, splits, or renames them, the Agent treats that message as the authority for semantic identity, updates Knowledge from the evidence already gathered, and does not rerun Machine discovery unless the user also asks for missing operational or scientific facts.

The default Home root is `~/.slop/knowledge`. The Workspace root is `<Workspace.path>/.dsh/knowledge`, using the current official DSH Workspace. The host process resolves both `~` and `Workspace.path`; neither path is resolved through SSH or against a Machine filesystem. The roots are independent of the DSH-SLOP product-data directory.

DSH-SLOP does not synchronize Knowledge across Hosts. A user may configure Home to a mounted or externally synchronized directory, but that transport owns availability and file conflicts. Knowledge digest checks detect a changed file; they do not merge competing edits.

## Markdown authority

Each Knowledge item is one Markdown file. Markdown is the sole content authority. A derived index may store locators, digests, extracted headers, headings, snippets, and search terms, but it must be disposable and rebuildable from the current files.

Search never treats an index row as proof that a file still exists or still has the indexed content. Read resolves `docRef` inside the effective Home and current Workspace sources, reads the current bytes, computes an opaque digest over those exact bytes, and refreshes stale derived data. A missing or unreadable file produces an explicit result rather than reconstructed content.

External editors remain valid. If a user changes, moves, or removes a Markdown file outside DSH-SLOP, later indexing reflects the filesystem. DSH-SLOP does not restore an older index copy.

## Header

Markdown created by an Agent has YAML frontmatter with exactly two required retrieval fields and one optional field:

```yaml
---
name: run-eos-analysis
description: Reuse an equation-of-state calculation pattern when preparing or adapting EOS work.
tags:
  - eos
  - equation-of-state
---
```

`name` is a short lowercase hyphenated name. `description` states both what the item contains and when it is useful. `tags` is an optional list of plain search synonyms. The core header has no Machine, software, scheduler, project, status, lifecycle, or domain-specific schema.

Existing Markdown without this header remains searchable and readable. The index derives a display name from its first heading or filename and a description from its first useful paragraph without changing the file. A malformed header produces a parse warning and the same bounded fallback; it does not make the body disappear.

Unknown frontmatter written by a user or another tool is preserved on update and ignored by core ranking. An Agent does not add unsupported fields to a newly created item.

## Search and read

Knowledge is retrieved only through explicit model calls:

- `slop_knowledge_search` searches Home and the current official Workspace with bounded results and snippets.
- `slop_knowledge_read` reads the exact current Markdown for a `docRef` and returns its digest. It accepts an optional heading plus `byteOffset` and `byteLimit` for bounded paging.

Search input is `query` with an optional result `limit`. Read input is `docRef` with optional `heading`, `byteOffset`, and `byteLimit`. Neither tool accepts a Machine id, Workspace id, root path, or arbitrary source list.

Search returns separate Home and Workspace candidates before combined ranking so a large scope cannot hide the other. Exact `name` and `tags` matches are strongest, followed by `description`, headings, and bounded body text. Headerless files compete on their derived fields and are not discarded merely for lacking frontmatter. File modification time is at most a weak tie-breaker; recent does not mean correct.

Home and Workspace items with the same name remain distinct results. Search does not merge their fields or silently make one authoritative for the other. Results identify `docRef`, scope, `relativePath`, name, description, tags, and a bounded snippet. Read returns the current digest and is required before an Agent relies on full contents or prepares an update.

Read returns a page with `byteOffset`, `byteLimit`, `totalBytes`, and optional `nextByteOffset`. It also returns bounded `availableHeadingPaths` copied from the current Markdown plus `headingPathsTruncated`. Section updates copy an exact returned path instead of reconstructing heading ancestry from prose. Reads default to an 8 KiB page; an explicit byteLimit may request at most 64 KiB of Markdown, and the complete model-visible tool result also has a fixed bound. Heading selection narrows the readable section before byte paging. The Agent follows `nextByteOffset` only while the remaining content is relevant; it does not page through a large item merely because more bytes exist.

There is no implicit Knowledge catalog in the Agent prompt, Chat bootstrap, Machine Info, or Workspace context. The Agent decides when the request could benefit from prior work, searches with terms from the request, and reads only the few relevant items.

## Write

Agents write Knowledge through one model tool:

- `slop_knowledge_write` uses `mode: create` to atomically create a new Markdown item and refuse an existing target, or `mode: update` to check the digest returned by `slop_knowledge_read` immediately before atomically changing an existing item.

Create requires `scope`, relative `.md` `path`, and complete `content`. The compatible full-document update accepts the same fields plus `expectedDigest`; omitting `operation` still selects this behavior. Workspace scope always resolves from the current official Workspace in host context.

When only named sections changed, update should use `operation: replace-sections` instead of resending the document. It accepts `sectionReplacements`, each with a complete `headingPath` from H1 through the target and exactly one of `body`, `bodyLines`, or `table`; neither form includes the target heading line. A path item may be title text or a complete Markdown heading line, whose single leading heading marker is normalized by the Host. `bodyLines` is a line-array alternative whose single-line strings the Host joins with newline characters; it can carry model-generated text directly, and table is a structured alternative for tabular sections. One call applies up to 32 unique, non-overlapping section bodies. The bodies total at most 64 KiB and the final document stays within the 1 MiB document limit. The host rejects an empty, missing, ambiguous, duplicate, or overlapping selector before it writes. It preserves frontmatter, heading lines, and every byte outside the selected bodies.

In Code Mode, keep the digest from the one relevant read and send only the new section bodies. Do not embed the old full document into JavaScript, return it to the model again, reread it for freshness, or use generic Workspace file tools on a Knowledge `relativePath`. Use ordinary structured tool arguments, with bodyLines or table when they simplify the payload; the Host joins lines and renders tables without generated comment-extraction or formatting helpers. `expectedDigest` detects an intervening user edit. A single `replace-sections` call handles all changed sections in that document as one transaction.

Before creating, the Agent searches for an existing item that already covers the subject. Before updating, it reads the selected item and preserves unrelated content and unknown user frontmatter. Agent-created Markdown must have the required `name` and `description`; `tags` remains optional. Updating a compatible headerless file does not require silently adding a header.

Create and update modes do not require a separate approval step. A successful create returns a `mode: create` receipt with its scope, `docRef`, `relativePath`, and new digest. A successful update returns a `mode: update` receipt with the same fields plus `previousDigest`. The Agent reports that discriminated receipt in Chat and states briefly what durable understanding changed.

Create fails if its target already exists. Update fails if the expected digest is missing or stale at its final verification. A section update also fails if its selectors no longer resolve against the digest-matched document. A detected conflict returns the current digest without writing, merging, retrying with an unconditional write, or choosing a winner. The Agent must read the current file and explain the conflict before proposing another change.

Writes through the same Knowledge service are serialized. An external editor or another process does not participate in that serialization: if it commits after the final digest verification but before replacement, the Knowledge write may win that race. This is a digest guard followed by atomic replacement, not a filesystem-wide compare-and-swap or merge protocol. Externally synchronized storage keeps responsibility for its own conflict copies and recovery.

There are no model tools for delete, rename, move, or unconditional overwrite. A user may still edit the Markdown authority with normal filesystem tools. Generalizing Workspace material into Home uses a separate create or digest-guarded update; it is not a rename or a hidden move.

All write targets use a normalized relative `.md` `path` inside the configured Home or current official Workspace Knowledge root. The host rejects absolute targets, traversal, root escape, and symlink escape. The model cannot change the configured Home path through a Knowledge write call.

Document writes may append up to eight contentTables to content; section replacement may use table instead of body or bodyLines. Tables supply columns and rows, with 1-16 columns, at most 128 rows, and bounded single-line cells. The Host validates row shape and renders escaped Markdown before the ordinary digest-guarded write, preserving existing scope, privacy, and atomicity checks. Empty tables are valid. A section replacement accepts exactly one body representation.

Knowledge Tool adapters preserve domain failure codes through the public upstream error type so a rejected write can be distinguished from an unknown outcome; repository-domain errors remain independent of the harness.

## Choosing Home or Workspace

Write Home Knowledge when the content is already systematic and should guide work in unrelated Workspaces. Examples include a repeatable analysis method, a general submission convention that distinguishes current Machine facts from reusable guidance, or an explanation of how to adapt a family of scripts.

Write Workspace Knowledge for details that are useful in the current Workspace but remain narrow, provisional, one-time, or tied to its files and decisions. Examples include why one input was chosen, where this Workspace keeps its canonical analysis script, or how a recent result was derived. Raw outputs and live job state stay outside Knowledge; the Markdown may cite their paths and digests.

If one finding contains both kinds, split it. The Home item describes the reusable method. The Workspace item records the local application and references its files. Do not copy the same paragraphs into both scopes.

An Agent creates or updates Knowledge when completed work, a user correction, or bounded discovery yields information with plausible future value. It does not turn every command, transient failure, or Chat summary into a Knowledge item.

## Referenced scripts and results

Knowledge Markdown may link to scripts, templates, inputs, results, or other evidence. A useful reference identifies the Machine when relevant, the path or URI, why it matters, and a digest when content identity matters. Workspace-local references may use paths under the official Workspace. A Machine/path reference is ordinary body content, not a scope, filter, header field, or claim that the target is still present. Exact paths and commands are allowed when they make the record useful; the Agent labels them as provenance and verifies them against current Machine Info and the filesystem before reuse.

The reference does not transfer ownership. DSH-SLOP does not copy, package, upload, synchronize, edit, or execute the target as part of Knowledge. An Agent uses native filesystem or shell facilities, checks the target still exists, and reviews it before reuse. A stale reference remains visible as stale evidence; the index never substitutes a cached copy.

Licensed datasets, pseudopotential contents, private source, credentials, and large scientific outputs must not be copied into Knowledge. Record a safe identifier, location, and digest when useful.

## Machine Info boundary

Machine Info owns connection state and approved current operating facts for one Machine: SSH and access setup, scheduler and account facts, partitions or queues, module and environment initialization, executable builds and paths, pseudopotential locations, filesystem roots, and submission defaults.

Knowledge owns reusable written understanding and finer Workspace notes. Its body may record that prior work used a named Machine, command, or path, and it may safely reference a script or result there. That record is provenance or guidance, not approved current Machine state. The Agent resolves and verifies it against current Machine Info and the filesystem before acting.

Deep Discovery partitions its findings accordingly. It proposes connection and current operating facts in Machine Info, writes systematic reusable methods to Home Knowledge, and writes finer project or one-time understanding to the current Workspace Knowledge. Knowledge writes follow their normal no-approval create and digest-guarded update rules and do not wait for Machine Info approval. The Agent reports their receipts separately from the Machine Info card. See [Machine](machine.md).

## Settings

Settings has a Knowledge section. It shows and edits the Home Knowledge path, whose default is `~/.slop/knowledge`, and displays the expanded effective path plus index status. Saving validates an absolute, non-root path but does not create it. An absent directory remains visible with `missing` source status. The first Knowledge create may safely materialize the root and required parent directories with owner-only access, or the user may create them outside DSH-SLOP.

The source list shows read-only status for Home and every registered Workspace, including each derived `<Workspace.path>/.dsh/knowledge` path and its accessibility and index state. This inventory does not widen retrieval: a Chat still searches Home plus its current official Workspace only. Settings cannot select an arbitrary directory as the current Workspace, edit Markdown, delete or rename items, resolve write conflicts, or search the contents of an unrelated Workspace.

Changing the Home path does not copy, move, merge, or delete files at the old path. The new effective root applies to later searches and writes. Existing Markdown remains where the user left it.

## Prefix cache and context

Prefix caching may reuse model computation when an input prefix is byte-for-byte stable. It does not remove those tokens from the model's finite context window, and a changing Knowledge catalog would also make the later prefix unstable.

For that reason, DSH-SLOP keeps only stable Knowledge tool definitions in the ordinary tool prefix. It does not inject names, descriptions, summaries, or recent items automatically. Search returns bounded metadata and snippets only when called; read returns selected Markdown only when needed. Both tool results still consume context in that Chat turn. Caching may reduce repeated processing, but it is not a substitute for selective retrieval.

## Security boundary

Knowledge content is user- or Agent-authored reference material. It cannot override system instructions, user intent, Skills, approvals, tool policy, or Machine access controls. Remote files and shell output discovered on a Machine are evidence, not instructions to persist or execute.

Agents must not write passwords, passphrases, OTP values, private keys, access tokens, cookies, protected terminal bytes, or unreviewed environment dumps into either scope. The host validates paths, serializes writers using the same service, and checks the expected digest before replacement; it does not coordinate arbitrary external writers or promise semantic redaction of Markdown. The Agent is responsible for selecting safe content before create or update.

Home Knowledge has a wider audience than Workspace Knowledge because every Agent on the same Host can retrieve it. Before creating a Home item, an Agent removes secrets and unsupported inferences, keeps only references that help future work, and labels Machine/path details as provenance that requires runtime verification.

Search and read grant no permission to execute a referenced command or file. Native shell, filesystem, scheduler, and protected authentication boundaries still apply.
