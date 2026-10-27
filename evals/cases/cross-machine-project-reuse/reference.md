# Synthetic reference state

The fixture for this case must expose the following semantic state without using
real credentials or licensed inputs.

- Home Knowledge contains one Markdown item describing a diffusion/MSD analysis
  script first used on Machine A. It records the script interface and validation
  checks separately from an observed Machine A environment/path binding.
- Workspace Knowledge contains a one-time note linking the current project to a
  tracked trajectory-producing run.
- Queue contains the run, its latest scheduler evidence, and a validated output
  artifact locator. At least one older tracked run is present so the Agent must
  choose by evidence rather than a filename alone.
- Machine B has a different environment activation and executable path from
  Machine A, while the script interface is compatible.
- The trajectory is a small fixture. The expected diffusion result and units are
  known to the scorer but are not embedded in product prompts.

No synthetic field is a new product schema. The fixture adapts ordinary
Machine, Queue, and Markdown Knowledge contracts.
