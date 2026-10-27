# Knowledge writes

Use slop_knowledge_write for one document at a time and inspect its receipt before another write.
For create, supply content beginning at the first byte with YAML frontmatter containing a lowercase hyphenated name and quoted nonempty description, plus quoted tags when useful for retrieval.
For update, copy the latest complete digest into expectedDigest and preserve existing frontmatter and unrelated content.
Prefer operation replace-sections, putting all changed sections for that document in one sectionReplacements array.
Each replacement uses an exact observed headingPath and one of body, bodyLines, or table; the Host joins line arrays and renders table columns/rows.
For a document write, contentTables appends structured tables to content without a model-authored renderer.
Pass ordinary structured arguments through the available tool binding; do not generate comment-extraction, escaping, table-rendering, or receipt-parsing helpers.

The receipt is at the top level, with mode, scope, docRef, relativePath, and digest; report those fields for each successful write.
A write failure throws; a known conflict or invalid-input failure permits one bounded correction after checking the current document.
An unknown write outcome or an outer program failure after a nested write is not permission to repeat it; retain the receipt and report the unresolved outcome.
Stop after the host's correction budget or a scope/security denial rather than starting a debugging loop.
