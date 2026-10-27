# Status

DSH-SLOP **0.0.15** is the first public preview for DeepSeek Harness **0.2.1-rc.3** exactly. Source and package checks pass; the full real-system gates remain pending. Earlier real-system observations below are historical evidence, not repeat validation of this release.

## What was checked

| Level | What it covers | Result |
| --- | --- | --- |
| Automated tests | Unit tests, local SSH and SFTP protocol fixtures (key, agent, password plus verification code, host-key changes, transfer limits), Slurm and PBS output parsing, Queue scheduling and delivery, Knowledge path and digest rules. Run with `pnpm check`. | The initial public snapshot passed on macOS (98 files, 617 tests passed, 5 skipped), and [Windows and Ubuntu CI](https://github.com/zrzrv5/dsh-slop/actions/workflows/ci.yml) passed with Node 24. Release preparation repeats package checks after packaging changes. |
| Installed plugin | `pnpm plugin:smoke` installs the `.tgz` into a temporary Harness profile, loads it, checks settings and the Machine event connection, removes it, and confirms the data remains. It makes no model call and no remote connection. | Passed in Windows and Ubuntu CI. Earlier desktop App observations on macOS and Windows are historical; they do not replace a fresh real-cluster login journey. |
| Real systems | Observed by the author on their own computers and clusters, not as a repeatable test suite. | See below. |

Real-system observations:

- Machine reused an app-managed SSH connection to transfer files between the Host and a real cluster. A 26,060-byte round trip kept an identical SHA-256.
- Queue tracked real Slurm jobs on two clusters. Authenticated webhook callbacks arrived through a public Cloudflare Quick Tunnel, and the scheduler later confirmed the result.
- On a local Host with a real model, a Queue item registered with `purpose: "continue"` woke its Chat on completion and verified the output files; a passive item delivered one notice without starting a turn. This was local runtime and Queue acceptance, not a fresh remote calculation.
- Local continuation across a Host restart was exercised.

## What was not checked

These steps have no completed real-system evidence. Plan to try them yourself:

- **A complete real login journey.** Setup through `/onboard-slop`, a real password or 2FA prompt, Deep Discovery, and Machine Info approval, from start to finish in one Chat. Protected 2FA is covered by local protocol fixtures, not by this journey.
- **Your scheduler and cluster.** PBS has parser tests but no real-cluster run. Slurm has been seen on two clusters only.
- **Queue recovery on real systems.** Stopped-Chat activation and packed checks across local and remote items.
- **Windows against a real remote host.** Native SSH was verified against local fixtures and the Windows named-pipe agent. Real remote login and VPN routing were not.
- **A named Cloudflare Tunnel on your own account.** The browser-guided setup was not exercised end to end.
- **Other Harness versions.** This release targets exactly 0.2.1-rc.3. Do not bypass its compatibility check.

## Known limits

- rc.3 live installation activates the archive's anchored component paths without a restart. Remove/install remains the tested archive replacement route and preserves product data. See the [installation guide](../INSTALL.md#update-or-remove).
- Native Windows SSH does not support ProxyJump, ProxyCommand, SSH certificates, hardware-key providers, agent forwarding, user-owned OpenSSH masters or legacy SCP. Set `DSH_SLOP_SSH_BACKEND=wsl` for those. Native connections last until the Host restarts.
- Commands run through `sh -lc`, so cluster profile scripts load as they do at login. Some print harmless `stty` errors to stderr in every command; the connect session check labels these as noise. Startup files that print to stdout, `exec` another shell or wait for input stop commands from running, which the session check reports.
- If a transfer deadline expires while the SFTP channel is still opening, the native Windows client closes the whole connection, so a 2FA Machine needs a new sign-in.
- Knowledge writes use a digest check followed by atomic replacement. They detect a changed file but are not a filesystem-wide compare-and-swap, and an external editor that writes between the check and the replacement can lose.
- Knowledge is not synchronized between computers.
- A webhook callback is best effort. It cannot report a job that was killed hard or lost with its node, so the scheduler check remains the authority.
- Chat histories upgraded by a newer Harness cannot be read by an older one. Keep a full backup of the Harness home before upgrading Harness.
- Some very early histories with a subagent descriptor version 2 are refused by Harness's own converter and are left unchanged.

A passing test does not claim access to a particular cluster or account. A real-system report should name the environment and what was observed, and must not record passwords, passphrases, one-time codes or protected terminal bytes.
