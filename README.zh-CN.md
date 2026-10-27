# DSH-SLOP

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件，让 Agent 更顺畅地在 HPC 集群上工作。

[English](README.md) · [安装](INSTALL.md) · [文档](docs/README.md) · [移植到你的 harness](PROMPT.md)

## 问题与解决方式

AI Agent 已经很擅长使用 HPC，但我在让它们管理 HPC 工作时还是遇到了一些问题：

- **访问。** 集群常需要 VPN、密码和 2FA。我希望 Agent 能复用 SSH 连接，又不让模型看到密码，还能更方便地在不同 HPC 资源之间开展工作。
- **等待。** 任务可能要跑几个小时。反复检查状态会消耗 token，而 Chat 结束后，也容易忘记继续跟踪任务。

DSH-SLOP 希望解决这些问题。（当然，如果 `tmux` 和 `claude rc` 已经够用，继续用它们也行。）

插件给你已有的 DSH Chat 增加四个组件。它不创建第二个 Agent、shell 或会话；实际工作仍由 DSH 自带的工具和你的领域 Skill 完成。

| 组件 | 作用 | 边界 |
| --- | --- | --- |
| [**Machine**](docs/machine.md) | 复用 SSH 登录来执行远程命令、传输文件，并保存经批准的机器信息。 | 密码和 2FA 在受保护的终端中输入。macOS/Linux 用 OpenSSH，Windows 用原生 SSH。 |
| [**Knowledge**](docs/knowledge.md) | 按需搜索的 Markdown 笔记，可在本机共享或限定于当前 Workspace。 | 写入需通过 digest 校验，无删除工具。使用其他 memory 插件时可停用。 |
| [**Queue**](docs/queue.md) | 跟踪已提交的 Slurm、PBS 和本地任务，状态变化时通知所属 Chat。 | 不提交、取消或重试任务。 |
| **Queue webhook**（可选） | 接收任务脚本的回调，让 Queue 更早获知任务开始和退出。 | 默认关闭。需要通过你自己的隧道或代理提供公网 HTTPS 地址。 |

各组件都可以在 Plugin Manager 中启用或停用。即使关闭 Machine，Queue 仍然可以跟踪本地任务。各部分如何配合见[架构](docs/architecture.md)。

## 快速上手

| 要求 | 版本 |
| --- | --- |
| DeepSeek Harness | 必须是 **0.2.1-rc.3**；其他版本未验证 |
| Node.js | `^22.19.0 \|\| >=24.0.0`，仅独立 CLI 需要 |
| SSH | macOS 和 Linux 使用 OpenSSH 客户端；Windows 需要 OpenSSH Client 功能 |

### 1. 安装

从 [v0.0.15](https://github.com/zrzrv5/dsh-slop/releases/tag/v0.0.15) 下载 `dsh-slop-0.0.15.tgz` 和对应的 `.sha256` 文件，也可以[从源码构建](INSTALL.md#build-the-installation-package)。不要解压 `.tgz`。

- **桌面 App：** **Plugins → Add plugin**，粘贴文件的绝对路径，依次选择 **Install**、**Enable now**。如果仍有组件显示 *Not running*，完全退出并重新打开 Harness 一次。
- **命令行：**

```sh
dsh plugin --profile web add /absolute/path/to/dsh-slop-0.0.15.tgz
dsh web
```

这个包没有发布到 npm，所以只输入 `dsh-slop` 无法安装。升级、卸载和故障排查见[安装指南](INSTALL.md)（英文）。

### 2. 连接一台机器

在新的 Chat 中输入：

```text
/onboard-slop
```

从 `~/.ssh/config` 中选择 SSH 主机，检查连接卡片，然后点击 **Connect**。密码或 2FA 在内嵌终端里完成。如果希望 Agent 检查环境，就勾选 **Deep Discovery**；它提议保存的机器信息需要你批准。

### 3. 试一试

> 显示这台机器上的当前目录，并检查有哪个调度器可用。

远程命令和结果会显示在 Chat 里。接着可以让 Agent 在运行某个项目已有脚本之前，先回忆之前项目的笔记，并跟踪它提交的任务。

## 常见问题

**支持哪些平台？** 我主要在 macOS 上开发和测试。Windows 预计可以正常使用；Linux 理论上也能运行，但我还没有亲自测试。已知限制见[状态](docs/status.md)。

**数据存在哪里？** Machine 和 Queue 的数据在 `~/.dsh/slop-plugin/slop`（设置了 `$DSH_HOME` 时在其下），位于安装包之外，所以卸载插件不会删除数据。Home Knowledge 默认是 `~/.slop/knowledge`，Workspace Knowledge 是 Workspace 里的 `.dsh/knowledge`。不会在多台电脑之间同步。Chat 和凭据仍由 DSH 管理。

**能和我现有的 DSH 分开试用吗？** 可以：`pnpm install --frozen-lockfile && pnpm build && pnpm dev` 会启动一个独立的数据目录。见[独立运行](INSTALL.md#run-as-a-standalone-app)。

**可以直接用在我的集群上吗？** [状态](docs/status.md)列出了哪些已检查、哪些没有。

## 移植到其他 harness

DSH-SLOP 建立在 DSH 的插件 API 之上，所以本仓库是一个参考实现，不是通用库。思路是可以移植的：[PROMPT.md](PROMPT.md) 是一份给你自己的编程 Agent（例如 Claude Code）的任务书，让它为另一个 harness 实现同样的 Machine、Knowledge 和 Queue。

## 参与开发

从 [docs/README.md](docs/README.md) 和 [AGENTS.md](AGENTS.md) 开始。检查命令：

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm plugin:smoke
```

[发布说明](CHANGELOG.md) · [MIT 许可证](LICENSE)
