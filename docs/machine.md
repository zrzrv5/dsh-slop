# Machine

Machine lets an Agent work on a computer you reach over SSH, such as a login node of an HPC cluster, without a new login for every command and without passwords passing through the model.

## Connect

Setup is opt-in. A new Chat shows nothing until you ask.

1. Enter `/onboard-slop`. The Agent lists the literal `Host` aliases in `~/.ssh/config` (and files it includes) and asks which to add. This scan runs no SSH command, makes no connection and reads no private key. Without SSH configuration, enter a `user@host` target by hand with `/setupmachine`.
2. A setup card asks for the SSH target, how you authenticate (**Requires 2FA** or **Passwordless key**), and the scheduler (Slurm, PBS, none or unknown). The alias, paths, notes and **Deep Discovery** are optional.
3. Select **Connect**. The Agent saves the Machine and establishes access. Passwords, passphrases and verification codes are typed into a protected terminal inside the Chat. They stay inside an owner-bound authentication channel and never become Chat text or tool arguments.
4. The same Chat carries on. No separate setup Agent is started.

A new or changed host key is shown for your approval and is never accepted automatically.

Right after connecting, the Agent runs one harmless test command (`printf`). If it never prints, the connection is fine but your account's startup files stop non-interactive sessions, for example a `~/.bashrc` that prints text, starts another shell or waits for input. Run `ssh <target> 'echo ok'` in a terminal to confirm, and put `[[ $- == *i* ]] || return` near the top of `~/.bashrc` so interactive-only lines are skipped. A line like `stty: 'standard input': Inappropriate ioctl for device` alone is harmless noise from a cluster profile script.

## Connection reuse

After you authenticate once, the connection is reused by the remote shell and by file transfers.

- **macOS and Linux:** OpenSSH connection sharing. An idle connection is kept for at least 12 hours while the Host runs.
- **Windows:** a native SSH client inside the plugin, with no WSL. It reads your Windows OpenSSH configuration and supports key files, the Windows ssh-agent, passwords and 2FA. Connections live until the Host restarts. For ProxyJump, ProxyCommand, certificates or hardware keys, switch to the optional WSL backend described in the [installation guide](../INSTALL.md#install-in-the-desktop-app).

Connections are runtime state. After a Host restart you reconnect; saved Machines and Machine Info remain.

## Shell and transfer

- `slop_machine_shell` runs one command on a named Machine and returns exit status, stdout and stderr. Command output is not redacted, so keep secrets out of commands. A timeout does not prove the remote process stopped; inspect before retrying anything that changes state.
- `slop_machine_transfer` copies a file or directory between the Host and a Machine, or between two Machines through the Host. They never connect to each other. SFTP is the default, and Chat shows progress.

Every call names its Machine. There is no global "current" Machine, and one Chat can use several.

## Machine Info

Machine Info is what future Agents should know about one Machine: scheduler and accounts, partitions, module and environment setup, executable paths, filesystem roots, submission defaults. It is saved only after you approve the exact proposal in Chat. Small corrections may be applied with an explanation; changes to access, scheduler, paths or defaults need approval again. The Agent checks Machine Info again at use time instead of trusting old text.

## Deep Discovery

Tick **Deep Discovery** in the setup card, or enter `/deep-discover <Machine>`. The Agent inspects the machine with bounded, one-at-a-time commands, starting from the project names and paths you give it. It does not scan whole filesystems. It proposes operating facts for Machine Info, writes reusable methods to Home [Knowledge](knowledge.md), and writes project-specific notes to the current Workspace.

## Boundaries

Machine does not submit jobs for you, watch them ([Queue](queue.md) does that), or store project notes. Full contract: [internals/machine.md](internals/machine.md).
