# TODO

## First public release

- [ ] Complete the maintainer's document review, including README translations, installation instructions, product contracts and status claims.
- [ ] Review licensing, third-party notices and candidate contents before publication.
- [ ] Complete the pending real-system evidence in `requirements/traceability.yml`; local tests do not satisfy these gates.
- [ ] Confirm the candidate version and supported Harness release before creating the first commit or release.
- [ ] Publish only after explicit maintainer authorization.
- [ ] After publication, add the repository description and plugin topic, upload the installation archive and checksum, and update download instructions.

## Product follow-ups

- [ ] Confirm on the Windows desktop App that **Enable now** starts all components without a restart.
- [ ] Track upstream plugin resolution on Windows before replacing anchored component paths with package names.
- [ ] Native Windows client: when a transfer deadline expires while the SFTP channel is still opening, close only that channel instead of the whole connection.
- [ ] Consider filtering known harmless startup noise from command stderr, or documenting it in the shell tool description.
- [ ] Measure behavior preferences against a real model before changing their wording.
- [ ] Reduce tool-definition overhead only with meaningful runtime and authorization checks.
