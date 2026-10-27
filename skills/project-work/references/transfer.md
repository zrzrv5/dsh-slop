# Transfer files

Respect a user-requested method or an established project transfer workflow
when available and suitable. Otherwise use `slop_machine_transfer` for saved
Machines. Do not spend calls trying unrelated alternatives first. Keep existing
connection and authentication boundaries, including Host relay between Machines;
an alternative method does not authorize a new Machine-to-Machine SSH path.

Before a directory copy, inspect only the exact requested source. Use a short
timeout and a capped file count or sample, plus approximate size and destination
free space when affordable. Stop counting once the many-files threshold is met;
do not recursively inventory an unknown root just to obtain an exact count.
Check destination conflicts and whether the source is still being written.

For hundreds or thousands of small files, prefer packing once on the source and
transferring one archive. For a few large files, a direct copy is usually enough.
Treat this as a heuristic. Decide compression separately from packing based on
CPU, compressibility and network cost; tar does not require gzip.

1. Create a unique temporary directory on the source, outside the source tree.
   Never delete or overwrite a fixed archive name to make room. Check space for
   the archive and space on the destination for both archive and extracted data.
2. Pack relative names under one root. Keep symlinks as links unless the user
   explicitly requested dereferencing. Record the source archive hash.
3. Transfer through the established route. Require success, exitCode 0 and
   timedOut false. A timeout may leave a partial destination; inspect it before
   choosing resume or a new unique staging location. Do not blindly delete it.
4. Verify the destination archive hash before extracting into a fresh staging
   directory. Reject absolute or parent-traversal archive members. Verify the
   expected layout and required files. File counts alone are not byte integrity.
5. Publish to the requested destination only after verification, refusing an
   existing destination unless replacement was explicitly requested. Remove only
   this operation's temporary artifacts after successful publication. Report
   retained partial data when recovery cannot finish.

If the source changes while packing, report the consistency problem rather than
calling the copy a verified snapshot. Transfer metadata and application-specific
validation establish different facts; report each accurately.

Use the archive hash plus a bounded layout check as the normal transfer proof.
Do not add repeated full-tree content or metadata fingerprints before and after
extraction or publication unless a concrete inconsistency requires them. Archive
extraction can change metadata; that alone is not evidence of damaged contents.

Modern scp uses SFTP by default. Some NAS servers expose different paths to SFTP and the shell (for example shell /volume1/work versus SFTP /work). If a verified shell destination is reported missing by SFTP, inspect the error and partial destination before trying protocol: "scp" on slop_machine_transfer. This explicitly uses the shell path namespace through scp -O, with the same Host-owned connections. Do not blindly retry or guess a new path.
