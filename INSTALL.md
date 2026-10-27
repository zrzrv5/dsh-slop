# Install DSH-SLOP

[README](README.md) · [中文 README](README.zh-CN.md)

This branch targets **DeepSeek Harness 0.2.1-rc.3** and the DSH-SLOP **0.0.15 release candidate**. It has not been published. Other Harness versions have not been verified. SLOP adds Machine, Knowledge and Queue to your existing Harness; keep your current model provider and account.

## Get the installation package

Build the candidate [from source](#build-the-installation-package). The commands below use `0.0.15`. After the first public release, download its `.tgz` and `.sha256` assets and compare the checksum with `shasum -a 256 -c dsh-slop-<version>.tgz.sha256`.

Keep the `.tgz` file compressed. If you download a GitHub Actions artifact as a `.zip`, unzip that outer file to get the `.tgz` inside.

The package contains SLOP's compiled code, UI, translations and Skills. Harness installs its runtime dependencies from npm. You do not need a source checkout, pnpm or a separate Node.js installation to install it through the desktop App.

The package name alone works only after an npm publication. `npx` runs npm packages; it is not a separate registry. SLOP is not published to npm yet. The GitHub source repository is a development workspace, so pasting its address into Add plugin does not install this package.

The standalone runtime includes upstream Plugin Market. Market indices accept npm packages or immutable Git sources; a release `.tgz` URL belongs in Add plugin, not in a market entry. After an approved npm publication, a maintainer can run `pnpm plugin:market-index --output /absolute/path/to/index.json`. It reads the exact version's registry metadata, validates the native index format, and refuses absent versions or an existing output file. Publishing the package and hosting that index are separate operations; this branch does neither.

## Install in the desktop App

Windows accepts paths such as `C:\Users\Alice\Downloads\dsh-slop-0.0.15.tgz`, including spaces and Unicode. Enabling the plugin does not require SSH.

Windows Machine connections run **natively, without WSL**. Install the Windows **OpenSSH Client** optional feature if `ssh` is unavailable; it resolves your Windows SSH configuration. The plugin keeps a native SSH connection for key/ssh-agent and protected password/2FA authentication, remote commands, and SFTP transfers. `/onboard-slop` reads `%USERPROFILE%\.ssh\config`; `~/` key paths refer to your Windows home. Connections use Windows networking directly, including VPN routes available to the Host process.

Native mode supports direct targets and ordinary SSH aliases. ProxyJump, ProxyCommand, SSH certificates, hardware-key providers, agent forwarding, user-owned OpenSSH masters, and legacy SCP (`protocol: "scp"`) require the optional WSL backend. To retain the 0.0.3 behavior, set `DSH_SLOP_SSH_BACKEND=wsl` and restart Harness; `DSH_SLOP_WSL_DISTRO` can select its distribution. WSL mode requires `ssh`, `scp`, and `ssh-keyscan` inside that distribution. Existing WSL-only aliases and keys must either stay in that mode or be configured separately for Windows. No keys, SSH configuration, or saved Machine records are copied or migrated automatically.

1. Open DeepSeek Harness and check that its version is **0.2.1-rc.3**.
2. Open **Plugins** in the sidebar, then **Add plugin**.
3. Paste the absolute path to `dsh-slop-0.0.15.tgz`. On macOS, select the file in Finder and press **Option–Command–C** to copy its pathname. Paste the path without extra quotation marks.
4. Select **Install** and wait for installation to finish. Keep the default registry unless you normally use another registry.
5. When installation finishes, select **Enable now**. The rc.3 package activates without restarting Harness. If the plugin page still shows a component as *Not running*, quit Harness completely and reopen it.
6. Open a new Chat and enter `/onboard-slop`. If Harness opens its welcome page and you already use another provider, choose **Add API Key → Set up later** to return to the workspace without changing credentials.

For example, the input can be:

```text
/Users/alice/Downloads/dsh-slop-0.0.15.tgz
```

A direct HTTPS download URL of the release's `.tgz` asset also works in this field. A GitHub Release page URL and the repository's Source code archive are different files.

## Install from the command line

Check the executable you will use:

```sh
dsh --version
```

It should print `0.2.1-rc.3`. If you use a standalone CLI installation, it requires Node.js `^22.19.0 || >=24.0.0`. You can install the pinned CLI with:

```sh
npm install --global @deepseek-ai/dsh@0.2.1-rc.3
```

The macOS App also includes a CLI executable. You can inspect it without changing your PATH:

```sh
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" --version
```

For an existing Web profile, stop the process serving that profile, then run:

```sh
dsh plugin --profile web add /absolute/path/to/dsh-slop-0.0.15.tgz
dsh web
```

If `dsh` is not on PATH, use the full executable path in both commands. Keep your usual `DSH_HOME` setting. For a custom Web profile, replace `web` in both commands, for example `dsh --profile research`. The desktop App uses its own reserved `desktop` profile; install there through its Plugins page. Installing into `web` does not install into the App.

This guide covers the desktop App and browser-based Web profiles. Headless, SDK and TUI profiles do not provide SLOP's settings and protected authentication UI.

## Check the installation

- The Plugins page includes DSH-SLOP and its Machine, Knowledge and Queue components. Queue callbacks are off by default.
- Settings has one **DSH-SLOP** section with tabs for Behavior, Machines, Knowledge and Queue; a Callbacks tab appears when Queue callbacks are enabled.
- A new Standard Chat opens without a connection card. `/onboard-slop` reads SSH configuration and asks you which machines to add. It uses your selected model; the scan itself makes no SSH connections. Confirm candidates, review the connection card, then select **Connect**.
- `/setupmachine` opens manual setup through the Agent. `/deep-discover <Machine>` starts the shared discovery Skill; the card’s Deep Discovery checkbox requests it after connection succeeds. Remote files are described as code, not local file links.
- Configure a model in Harness before using an Agent. SLOP does not supply a model provider.

For the CLI profile, you can also run:

```sh
dsh --profile web --dump-config
```

The composed config should include `slop-runtime`, `slop-machine`, `slop-knowledge`, `slop-queue` and disabled `slop-queue-callbacks`. Do not replace your profile manifest with a documentation example.

## Data location

For a normal plugin installation, Machine and Queue data live under:

```text
~/.dsh/slop-plugin/slop/
```

If you set `DSH_HOME`, the location is `$DSH_HOME/slop-plugin/slop/`. You do not need to set `DSH_SLOP_HOME`. The directory is outside the installed package, so removing the plugin leaves its data in place.

Existing installations that set `DSH_SLOP_HOME` continue to use `$DSH_SLOP_HOME/slop/`. Keep that override when upgrading; dropping it selects the new default, which can make existing machines appear missing. This change does not migrate or delete old data. If running separate Hosts at the same time, give them separate `DSH_HOME` or `DSH_SLOP_HOME` directories.

Home Knowledge still defaults to `~/.slop/knowledge`. Workspace Knowledge remains in `.dsh/knowledge` inside the selected Workspace. Change Knowledge roots through Settings. Model credentials and Chats stay in Harness.

## Build the installation package

These commands are for developers or users who have only the source. They require Git, Node.js `^22.19.0 || >=24.0.0`, npm and pnpm `11.19.0`.

```sh
git clone https://github.com/zrzrv5/dsh-slop.git
cd dsh-slop
pnpm install --frozen-lockfile
pnpm plugin:pack
```

The command builds SLOP and prints the absolute path to:

```text
artifacts/dsh-slop-0.0.15.tgz
artifacts/dsh-slop-0.0.15.tgz.sha256
```

Install that `.tgz` using either route above. You can send it to another user without sending your checkout, Node modules, profile, credentials or data. The plugin archive contains JavaScript and assets; the separate `release:pack` archive is a standalone launcher distribution and is not an Add plugin package.

Before sharing a build, run:

```sh
pnpm check
pnpm plugin:smoke --no-build
```

The packer refuses to overwrite a versioned archive with different contents. Increase the version in `packages/bundle/package.json` for a changed release; keep older archives for rollback. Repacking identical contents is allowed.

The smoke check installs the archive into a temporary Web profile on the pinned Harness version, starts the Host without a SLOP home override, checks settings and the Machine event connection, then removes the plugin and verifies that its data remains. It does not call a model or connect to a remote machine.

For source development only, you can still build and link `packages/bundle` with `dsh plugin --profile web link "$PWD/packages/bundle"`. That link needs the checkout to stay in place. Use the archive for sharing.

## Run as a standalone app

To try SLOP in a separate browser runtime, build the source and start the launcher:

```sh
pnpm build
pnpm dev
```

This creates a separate product home. It does not install SLOP into the desktop App or your existing Web profile. Configure a model in the new runtime. Use `pnpm dev -- --data-location` to see its data directory and `pnpm dev -- --diagnostics` for startup details.

Model providers and deployment configuration are maintained outside this repository. See [standalone runtime and external configuration](docs/internals/runtime.md).

## Update or remove

For a versioned archive replacement, use the tested remove/install route below. A running Host can activate a newly installed bundle without restarting; replacement may still require a restart, as reported by Plugin Manager.
1. Back up the data directory, then close the failed installation dialog if it is open.
2. Open **Plugins → DSH-SLOP → Uninstall**. Remove only DSH-SLOP; your provider stays installed. This removes the package, not saved Machines, Queue records, Knowledge files, or Chats.
3. Return to **Plugins → Add plugin** and install the new versioned `.tgz`, then select **Enable now**.
4. Quit and reopen Harness. Check that Plugins shows the new SLOP version and four running components.

Keep the same data directory and Harness version. Current plugin package: `dsh-slop-0.0.15.tgz`; Harness baseline: `0.2.1-rc.3`.

For the CLI, stop the Web Host and run:

```sh
dsh plugin --profile web remove dsh-slop
dsh plugin --profile web add /absolute/path/to/new/dsh-slop-0.0.15.tgz
dsh web
```

To remove SLOP permanently from the profile, omit the second command. Your Machine, Queue and Knowledge data remain. Older source-link users should remove `@dsh-slop/bundle` before installing `dsh-slop`, so the same components are not loaded twice. Keep their existing data override.

Do not upgrade Harness itself just to try this plugin without reading [migration behavior](docs/internals/runtime.md#upgrade-behavior). Older Chat formats may not support rollback.

## If something is missing

| Symptom | What to do |
| --- | --- |
| Package not found after entering `dsh-slop` | Use the absolute `.tgz` path. There is no npm publication yet. |
| GitHub repository installation fails | Use the built `.tgz`, not the source repository or GitHub Source code archive. |
| Local file not found | Use the full path without quotes; keep `.tgz` compressed. |
| Incompatible version | Check Harness is `0.2.1-rc.3`. Do not bypass the compatibility check. |
| Installed in CLI but absent in App | CLI `web` and App `desktop` are separate profiles. Install through the App's Plugins page. |
| `Could not enable` / `failed to import` immediately after installation | Check the exact Host/package versions and the failing component diagnostic. The old rc.2 bare-name resolution workaround is no longer used. Then check that the component list shows four running and one off. |
| No DSH-SLOP settings section, or a tab is missing | Check SLOP is enabled in that profile, then restart Harness and open a new Chat. |
| “Which package was installed cannot be told from the dependency change” | Close the dialog, uninstall DSH-SLOP, then install the new archive and restart. Do not keep retrying Add on the same installed package. |
| Previously saved machines are missing | Restore the same `DSH_SLOP_HOME` override used by the previous installation. |
| Relative data-path error | Any explicit `DSH_SLOP_HOME` must be an absolute path. Remove an unused override or correct it. |
| Connected, but every command fails with no output | The connect result's session check explains it: your account's startup files (`~/.bashrc`, `~/.bash_profile`, `~/.profile`) stop non-interactive sessions. Check with `ssh <target> 'echo ok'` in a terminal and guard interactive-only lines with `[[ $- == *i* ]] \|\| return`. A lone `stty: ... Inappropriate ioctl for device` line is harmless. |
| `WSL could not run a Linux command` (WSL mode only) | Install WSL and a distribution with `ssh`, `scp` and `ssh-keyscan`, finish its first-run setup, or remove `DSH_SLOP_SSH_BACKEND=wsl` to use the native client. |
| Authentication terminal cannot attach | Use the build for the pinned Harness version, then quit and reopen the App. Include the installed versions when reporting a failure. |
| Chat cannot make model requests | Configure and select a model in Harness. |

What has and has not been tested is on the [status page](docs/status.md).
