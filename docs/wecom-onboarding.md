# botmux 企业微信适配与本地部署指南

本文对应 `codex/wecom-support` 分支，面向希望在自己电脑或服务器上接入企业微信智能机器人的开发者。实现与验收日期：2026-09-20。

- [代码仓库](https://github.com/liuxiguang/botmux)
- [企业微信适配分支](https://github.com/liuxiguang/botmux/tree/codex/wecom-support)
- [上游项目](https://github.com/deepcoldy/botmux)
- [配置说明](https://github.com/liuxiguang/botmux/blob/codex/wecom-support/docs/wecom.md)
- [完整验收记录](https://github.com/liuxiguang/botmux/blob/codex/wecom-support/docs/wecom-validation.md)

本次 fork 保留上游历史，企微改动位于专用分支。部署时必须克隆这个分支；上游安装脚本、npm 正式版和 fork 的 `master` 不代表已经包含本次功能。

## 1. botmux 是什么，消息如何执行

botmux 把聊天软件与本地 AI 编程工具连接起来。它管理消息路由、排队、会话进程、结果回传和恢复；实际推理、读写文件、执行命令、工具调用和模型登录由底层 CLI 完成。

原有飞书路径由 daemon 接收消息，再交给会话 worker。每个会话使用 CLI 适配器连接 Codex、Claude Code 等工具；本地终端可由 PTY 或 tmux 承载。CLI 会话拥有自己的连续对话上下文，botmux 负责找到正确的会话并提交下一轮输入。

这次企业微信路径如下：

```text
企业微信单聊 / 内部群 @机器人
        ↓ 官方 WebSocket 长连接
企微接入层：认证消息、白名单、去重、SQLite 排队
        ↓ 本机异步任务接口
专用 core-only：复用 botmux 会话与 worker 管理
        ↓ CLI 适配器 + tmux / PTY
AI 编程 CLI（本次实测为 Codex app-server）
        ↓ 完成状态和最终文本
企微接入层：结果落盘、发送队列、等待平台回执
        ↓
结果回到原单聊或群聊
```

电脑或服务器必须保持运行并能访问企业微信与模型服务。长连接由本地主动建立，无需公网入站端口或回调域名。[企业微信官方 SDK](https://github.com/WecomTeam/aibot-node-sdk)提供长连接认证、心跳、重连和消息发送能力；botmux 在此之上实现执行调度。

## 2. 这次具体改了什么

代码层面新增了独立企微入口，保留原来的飞书入口和身份模型。

| 模块 | 责任 |
| --- | --- |
| `src/cli/wecom-command.ts`、`src/index-wecom.ts` | 提供 `wecom check-config` 与 `wecom serve` 命令 |
| `src/im/wecom/config.ts` | 校验配置、白名单和凭证来源，拒绝未知字段 |
| `src/im/wecom/transport.ts` | 封装官方 SDK、连接状态、接收确认、最终结果和发送回执 |
| `src/im/wecom/message.ts` | 校验回调中的机器人及发送者，生成会话键，按 UTF-8 字节拆分长答案 |
| `src/im/wecom/store.ts` | 用 SQLite 保存会话映射、入站消息、任务状态及 outbox 发送账本 |
| `src/im/wecom/bridge.ts` | 同会话串行、不同会话并发、命令处理、幂等提交、轮询和恢复 |
| `src/im/wecom/runtime.ts` | 启动专用 core-only、检查端口、单机器人进程锁、优雅退出 |
| `src/core/self-spawn.ts` 等 | 支持源码和单文件编译版的子进程入口，隔离企微运行状态和凭证环境变量 |

适配采用的几个关键规则：

1. **整个群共享一个 CLI 会话。** 群成员的请求按顺序执行；不同群、不同单聊分别映射到不同会话。
2. **先落盘，再确认接收。** 同一平台消息重复到达不会重复创建任务；提交响应丢失后复用同一幂等键查询或重试。
3. **执行成功和投递成功分开记录。** CLI 已完成不等于企业微信已收到；平台回执未知时保留未知状态，避免无限重发。
4. **重启恢复已保存的任务。** 不宣称平台会补发离线期间未接收的消息，也不承诺跨网络的绝对一次投递。
5. **不让企微 Secret 继承进 CLI 环境。** 但这不等于文件系统隔离，同一操作系统用户仍可能读取本机文件。

同时修复了 Codex App 的静默完成路径：最终输出被明确抑制时，异步任务也能落为 completed，避免一直显示 running。两个功能提交分别为 `6d30f73b` 和 `52d40596`。

## 3. 申请自己的企业微信机器人

需要企业微信组织内具备创建或管理智能机器人的权限；没有入口时，请让企业管理员协助开启或创建。

1. 在企业微信客户端进入「工作台 → 智能机器人 → 创建 → 手动创建」。管理后台也可从「安全与管理 → 管理工具 → 智能机器人」进入，具体菜单随客户端版本及企业权限不同而变化。
2. 填写机器人名称、头像、简介以及可使用成员范围。
3. 选择「API 模式创建」，在 API 配置中选择「使用长连接」。
4. 获取 Bot ID 和 Secret 并保存机器人。这里使用的是长连接凭证，不能用普通群 Webhook 地址或 URL 回调模式的 Token/EncodingAESKey 替代。
5. 先允许自己使用；需要群聊时，再把机器人加入内部测试群。

创建页面可参考[腾讯官方操作说明](https://cloud.tencent.com/document/product/1831/137051)。本文只使用其机器人创建步骤，后续运行的是 botmux，无需安装 CodeBuddy。

一个机器人同时只运行一个接入服务。迁移已有 Demo 时先停止旧连接，再启动 botmux；多人各自在电脑部署时，应分别申请机器人。

## 4. 准备本地环境并获取代码

本次真实验证环境为 macOS、Bun 1.4.2、Codex App 的 CLI 和 tmux。Linux 的源码运行方式相同，但本次没有完成 Linux 真实企微链路验收；Windows 建议在 WSL2 中部署，不能把 macOS 验证结果视为其他平台已通过。

准备 Git、Bun 1.4.2、Node.js 22.13 或更高版本、tmux，以及 C/C++ 编译工具和 Python 3。Node 用于构建脚本；源码依赖中的 node-pty 可能需要本机编译工具。

macOS 可先安装 Command Line Tools 和 tmux；Bun 与 Node 按各自官方说明安装。检查：

```bash
git --version
bun --version
node --version
tmux -V
```

从一个全新的、独立 clone 开始：

```bash
git clone --branch codex/wecom-support --single-branch https://github.com/liuxiguang/botmux.git
cd botmux
bun install --frozen-lockfile
bun run build
```

这里的 install 仅用于新 clone。已有开发 worktree 不要直接运行 install，尤其不要在共享 node_modules 的 symlink 上安装依赖。仓库的 `trustedDependencies` 必须保留 electron 和 node-pty。

安装并登录你要使用的 AI CLI。以 Codex 为例，确保以下命令可用，再手动执行一次简单任务验证模型登录与访问正常：

```bash
codex --version
codex login
codex app-server --help
```

`cliId: "codex-app"` 表示通过 Codex app-server 协议工作，不要求额外启动桌面聊天窗口；启动服务的 PATH 必须能找到 `codex`。

## 5. 创建私有配置与访问白名单

在仓库外保存凭证、账本及工作目录。以下命令在 botmux 仓库根目录运行：

```bash
umask 077
export BOTMUX_WECOM_DIR="$HOME/.botmux/wecom/team-bot"
mkdir -p "$BOTMUX_WECOM_DIR/project" "$BOTMUX_WECOM_DIR/state"
cp examples/wecom/config.example.json "$BOTMUX_WECOM_DIR/config.json"
touch "$BOTMUX_WECOM_DIR/wecom.env"
chmod 600 "$BOTMUX_WECOM_DIR/config.json" "$BOTMUX_WECOM_DIR/wecom.env"
```

用本地编辑器填写 `wecom.env`，不要把真实值提交到 Git、发到群里或贴到共享文档：

```dotenv
WECOM_BOT_ID=你的机器人标识
WECOM_BOT_SECRET=你的长连接密钥
```

完整配置示意如下。相对路径均以配置文件所在目录为基准；`workingDir` 必须提前创建，JSON 字符串里不要使用 `~` 代替绝对路径。

```json
{
  "botName": "编程助手",
  "workingDir": "./project",
  "stateDir": "./state",
  "envFile": "./wecom.env",
  "corePort": 19321,
  "cliId": "codex-app",
  "allowedUsers": ["填写本人经过认证的发送者标识"],
  "adminUsers": ["填写本人经过认证的发送者标识"],
  "allowedChats": [],
  "maxConcurrent": 2,
  "maxQueuedPerChat": 20
}
```

- `allowedUsers` 必填；只允许明确列出的用户，不能按昵称推测身份。管理员必须同时在此列表。
- `allowedChats: []` 只开放已获准用户的单聊。开放群聊时，把实际群标识加入数组，且发消息的人仍须在 allowedUsers 中。
- 企微平台可使用范围和本地白名单必须同时满足。
- `botName` 与机器人当前显示名保持一致，便于识别群内前导 @ 后面的 `/status` 等命令。
- 每个部署实例使用自己的 stateDir 和空闲 corePort；不要共用飞书或另一机器人的状态目录。
- 进程环境中的同名 WECOM 凭证优先于 env 文件；切换机器人时检查终端里是否残留旧变量。

### 初次部署如何取得白名单标识

优先由管理员提供已核实的标识。也可以在启动 botmux 前，用下面的临时诊断命令读取该机器人认证连接收到的消息元信息。它不会执行任务或回复消息；只在本机终端显示发送者及会话标识，不打印正文和 Secret。

先停止该机器人其他连接服务。在仓库根目录运行：

```bash
bun --env-file "$BOTMUX_WECOM_DIR/wecom.env" -e '
import { WSClient } from "@wecom/aibot-node-sdk";
import { ProxyAgent } from "proxy-agent";
const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const client = new WSClient({
  botId: process.env.WECOM_BOT_ID,
  secret: process.env.WECOM_BOT_SECRET,
  logger: quiet,
  wsOptions: { agent: new ProxyAgent() }
});
let ready = false;
client.on("authenticated", () => {
  ready = true;
  console.log("已认证：请本人单聊机器人，或在目标内部群 @机器人发一句测试文字");
});
client.on("disconnected", () => { ready = false; });
client.on("message", frame => {
  const b = frame.body;
  if (!ready || b?.aibotid !== process.env.WECOM_BOT_ID) return;
  console.log(JSON.stringify({ sender: b.from?.userid, chat: b.chatid, type: b.chattype }));
});
client.on("error", () => console.error("连接错误：检查凭证和网络"));
process.on("SIGINT", () => { client.disconnect(); process.exit(0); });
client.connect();
'
```

在本人发出的测试消息中取得 sender，填入 allowedUsers/adminUsers；在目标群测试消息中取得 chat，填入 allowedChats。收集完成按 Ctrl+C 断开诊断连接，再启动正式服务。不要把任意收到的陌生发送者自动加入白名单。

## 6. 启动、测试与查看日志

校验只检查配置结构和凭证是否填写，不联网验证有效性：

```bash
bun dist/cli.js wecom check-config --config "$BOTMUX_WECOM_DIR/config.json"
```

前台启动并保留桥接日志：

```bash
set -o pipefail
bun dist/cli.js wecom serve --config "$BOTMUX_WECOM_DIR/config.json" 2>&1 | tee -a "$BOTMUX_WECOM_DIR/bridge.log"
```

看到 `[wecom] authenticated` 和 `[wecom] ready`，才表示企微认证和执行服务均已就绪。终端保持运行；Ctrl+C 停止本次接入服务。

按照以下顺序验收：

| 操作 | 应看到的结果 |
| --- | --- |
| 单聊发送「计算 17×19，只返回结果」 | 先收到接收确认，再收到 323 |
| 单聊发送「记住测试词海风529」，再追问 | 同一会话能继续使用上下文 |
| 内部群 @机器人发送计算任务 | 群内收到接收确认和最终结果 |
| 两名已获准成员依次在同群提问 | 共用上下文，同一时间只执行该群的一轮输入 |
| 单聊 `/status`，群里 @机器人 `/status` | 返回任务状态、排队数和投递状态 |
| 管理员空闲时 `/new`，再发新消息 | 下一条任务使用新会话上下文 |
| 停止并重新运行同一配置，继续追问 | 已持久化会话可恢复；以日志和真实回复验证 |

另一个终端查看：

```bash
tail -f "$HOME/.botmux/wecom/team-bot/bridge.log"
tail -f "$HOME/.botmux/wecom/team-bot/state/core.log"
tmux ls
```

bridge.log 中的 `received → submitted → completed → delivered` 可按同一个本地任务编号串起来。接收确认和最终结果都可能各有一条 delivered；不能只看见一条 delivered 就认定最终回答已经送达。

可选：安装了 sqlite3 时，用只读查询检查任务与发送账本：

```bash
sqlite3 -readonly "$HOME/.botmux/wecom/team-bot/state/wecom.sqlite" \
  'SELECT id, phase, sessionId, triggerId FROM messages ORDER BY id DESC LIMIT 10;'
sqlite3 -readonly "$HOME/.botmux/wecom/team-bot/state/wecom.sqlite" \
  'SELECT messageId, kind, ordinal, state, attempts FROM outbox ORDER BY id DESC LIMIT 20;'
```

tmux 中 `bmx-` 开头的是会话终端。用 `tmux attach -r -t 实际会话名` 只读查看，按 Ctrl+B 再按 D 退出查看。任务完成后终端继续保留，正常 daemon 重启通常也保留它；默认超过每 Bot 30 个活跃 worker 才回收空闲会话，没有闲置时间自动关闭机制。当前企微 `/new` 不会立即关闭旧终端，也没有 `/close` 命令。

## 7. 模型、记忆、更新和运行边界

### Codex 默认配置

默认 cliId 是 codex-app。企微 JSON 可以可选填写 `model`，但当前不支持在这里直接填写 reasoningEffort 或 serviceTier；未知字段会被拒绝。

没有显式覆盖时，Codex 新会话读取其 CODEX_HOME 下的配置。若未设置独立 CODEX_HOME，通常使用 `~/.codex`，与同一系统用户的 Codex App 共用登录、用户级配置和长期记忆。群与单聊的对话上下文分开，不代表文件目录或长期记忆隔离。

当前 codex-app runner 显式使用 `approvalPolicy: never` 和 `sandbox: danger-full-access`。因此该入口应提供给可信成员；不要把“独立工作目录”当成系统权限沙箱。需要多人隔离时，应以专用系统账号或容器等方式建立实际权限边界，并单独验证。

### 长期运行与更新

先前台跑通，再用 launchd（macOS）或 systemd（Linux）托管同一条 `wecom serve` 命令。服务定义使用 bun、dist/cli.js、配置文件和工作目录的绝对路径，并显式提供可找到 codex/tmux 的 PATH。进程退出后需要重启策略；只有终端中的前台命令不会自动变成开机服务。

企微入口自行管理专用 core-only 子进程。`bun run daemon:restart`、`botmux start` 和 `botmux setup` 的原有飞书管理流程不能替代这里的 `wecom serve`。

更新时先完成当前任务，停止旧企微服务，再更新源码、构建并重新启动。源码构建会清理 dist，应在源码版服务停止后操作，或先在独立部署目录构建再切换。不要同时启动同一机器人的第二个实例。

需要生成当前平台单文件版本时：

```bash
bun run build:bun -- --out "$BOTMUX_WECOM_DIR/bin/botmux"
"$BOTMUX_WECOM_DIR/bin/botmux" wecom check-config --config "$BOTMUX_WECOM_DIR/config.json"
"$BOTMUX_WECOM_DIR/bin/botmux" wecom serve --config "$BOTMUX_WECOM_DIR/config.json"
```

单文件版本包含 botmux 运行时，但仍需要安装并登录底层 AI CLI；不要复制到不同 OS/CPU 的机器上使用。

### 常见排查

| 现象 | 检查方向 |
| --- | --- |
| 找不到 `wecom` 命令 | 是否使用适配分支构建出的 dist/cli.js，而不是 PATH 中的旧版 botmux |
| 配置检查通过但没有 ready | 配置检查不验证网络；继续查看凭证、代理和 core.log |
| `inbound_rejected` | 用户/群白名单、回调中的机器人身份、消息类型 |
| 有接收确认但一直没有最终结果 | `/status`、core.log、CLI 登录、任务 phase 和 outbox 状态 |
| `core-only 端口已占用` | 换空闲 corePort；不要复用另一部署的状态目录 |
| 被新连接顶替、重复启动被拒绝 | 检查旧 Demo、诊断命令及另一台电脑上的同机器人连接 |
| 明确失败后后续任务未执行 | 会话进入暂停状态；排查后由管理员在空闲时 `/new` |
| 发送结果未知 | 查询平台界面和 outbox；不要据此重复执行有副作用的任务 |

当前仅支持文本任务、接收确认和最终结果。逐 token 展示、图片/文件/语音输入、企微交互卡片、远程终端授权和权限确认按钮尚未接入。每会话默认最多 20 个未完成任务，全局默认同时执行 2 个不同会话。

## 8. 已验证到什么程度

2026-09-20 的功能验收包括：企微定向测试 7 文件 28 项通过；企微与公共路径回归 144 项通过；Codex 静默完成相关回归 190 项通过；源码构建与单文件构建通过。

真实环境观察到群内计算、同群追问、单聊隔离、状态查询、新上下文、跨源码/编译版重启恢复、静默完成回传，以及平台发送回执。多人同群排队由协议测试覆盖，真实界面验证只使用一个已授权登录用户。

全量测试记录为 24,621 通过、2 失败、133 跳过，不能表述为全量全绿。其中一个失败在未修改基线同样存在，另一个单独重跑通过。完整范围与证据保存在仓库验收记录中。

后续优先完善的方向包括：白名单登记向导、企微 `/close` 和 `/new` 旧会话回收、连接服务自启动向导、媒体输入、增量结果展示，以及更多平台/CLI 的真实验收。这些是后续工作，不属于本版已交付能力。
