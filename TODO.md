# TODO

## Stable release acceptance

- [ ] Complete the pending real-system evidence in `requirements/traceability.yml`: the full real Chat login journey and local/remote Queue recovery. Local tests and preview publication do not satisfy these gates.

## Future releases

- Review documentation, licensing, third-party notices, the version and exact Harness pin before publishing.
- Prepare an immutable release as a draft, attach and verify the installation archive and checksum, then publish.
- Keep download instructions and the supported-version table aligned with the release.

## Product follow-ups

- [ ] Confirm on the Windows desktop App that **Enable now** starts all components without a restart.
- [ ] Track upstream plugin resolution on Windows before replacing anchored component paths with package names.
- [ ] Native Windows client: when a transfer deadline expires while the SFTP channel is still opening, close only that channel instead of the whole connection.
- [ ] Consider filtering known harmless startup noise from command stderr, or documenting it in the shell tool description.
- [ ] Measure behavior preferences against a real model before changing their wording.
- [ ] Reduce tool-definition overhead only with meaningful runtime and authorization checks.
