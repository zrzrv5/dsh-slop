# DSH-SLOP

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that helps agents work on HPC clusters with less friction.

[中文](README.zh-CN.md) · [Install](INSTALL.md) · [Documentation](docs/README.md) · [Port it to your harness](PROMPT.md)

## The problem and the solution

AI agents are pretty good at using HPC, but I've run into a few problems when using them to manage HPC work:

- **Access.** Clusters sit behind VPNs, passwords and 2FA. I want agents to reuse SSH connections without exposing my password to the model, and to work across HPC resources more easily.
- **Waiting.** Jobs can run for hours. Repeated status checks consume tokens, and it's easy to lose track of a job when a Chat ends.

DSH-SLOP aims to help with these problems. (Or stick with `tmux` and `claude rc` if that already works for you.)

The plugin adds four components to your existing DSH Chats. It creates no second Agent, shell or conversation; DSH's own tools and your domain Skills still do the actual work.

| Component | What it does | Boundary |
| --- | --- | --- |
| [**Machine**](docs/machine.md) | Reuses SSH logins for remote commands and file transfers; keeps approved machine facts. | Protected password/2FA prompts. OpenSSH on macOS/Linux; native SSH on Windows. |
| [**Knowledge**](docs/knowledge.md) | Markdown notes searched on demand, shared on this computer or scoped to the current Workspace. | Digest-guarded writes; no delete tool. Disable it if you use another memory plugin. |
| [**Queue**](docs/queue.md) | Tracks submitted Slurm, PBS and local jobs; notifies their Chats when status changes. | Never submits, cancels or retries work. |
| **Queue webhook** *(optional)* | Receives job-script callbacks so Queue learns about starts and exits sooner. | Off by default. Requires a public HTTPS endpoint through your tunnel or proxy. |

Each component can be enabled or disabled in Plugin Manager. Queue still tracks local jobs when Machine is off. How the pieces fit together is in [architecture](docs/architecture.md).

## Quick start

| Requirement | Version |
| --- | --- |
| DeepSeek Harness | **0.2.1-rc.3** exactly; other versions are unverified |
| Node.js | `^22.19.0 \|\| >=24.0.0`, only for the standalone CLI |
| SSH | OpenSSH client on macOS and Linux; Windows OpenSSH Client feature on Windows |

### 1. Install

[Build the installation package from source](INSTALL.md#build-the-installation-package). Release downloads will be added after the first public release. Do not unpack the generated `.tgz`.

- **Desktop App:** **Plugins → Add plugin**, paste the file's absolute path, **Install**, **Enable now**. If a component still shows *Not running*, quit and reopen Harness once.
- **Command line:**

```sh
dsh plugin --profile web add /absolute/path/to/dsh-slop-0.0.15.tgz
dsh web
```

The package is not on npm, so `dsh-slop` alone is not an install route. Updating, removing and troubleshooting are in the [installation guide](INSTALL.md).

### 2. Connect a machine

In a new Chat:

```text
/onboard-slop
```

Pick SSH hosts from your `~/.ssh/config`, review the connection card, and select **Connect**. Complete any password or 2FA prompt in the inline terminal. Enable **Deep Discovery** if you want the Agent to inspect the environment; you approve the machine facts it proposes to save.

### 3. Try it

> Show the current directory on this machine and check which scheduler is available.

The remote command and its result appear in Chat. Then ask the Agent to recall notes from an earlier project before running its existing script, and to track the job it submits.

## Questions

**Which platforms are supported?** macOS is my main development and testing platform. Windows is expected to work. Linux should work in theory, but I haven't tested it myself. See [status](docs/status.md) for known limitations.

**Where is my data?** Machine and Queue data live in `~/.dsh/slop-plugin/slop` (under `$DSH_HOME` if set), outside the installed package, so removing the plugin keeps them. Home Knowledge defaults to `~/.slop/knowledge`; Workspace Knowledge is `.dsh/knowledge` inside the Workspace. Nothing is synchronized between computers. Chats and credentials stay in DSH.

**Can I try it separately from my existing DSH setup?** Yes: `pnpm install --frozen-lockfile && pnpm build && pnpm dev` starts a separate home. See [standalone setup](INSTALL.md#run-as-a-standalone-app).

**Is it ready for my cluster?** [Status](docs/status.md) lists what was checked and what was not.

## Port it to another harness

DSH-SLOP is built on DSH's plugin API, so this repository is a reference implementation rather than a library. You can port the design: [PROMPT.md](PROMPT.md) is a brief you can give your own coding agent, such as Claude Code, to build the same Machine, Knowledge and Queue for a different harness.

## Contributing

Start with [docs/README.md](docs/README.md) and [AGENTS.md](AGENTS.md). Run the checks with:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm plugin:smoke
```

[Release notes](CHANGELOG.md) · [MIT license](LICENSE)
