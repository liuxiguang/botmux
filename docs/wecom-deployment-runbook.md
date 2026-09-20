# 从零部署：人工与 Agent 操作手册

目标：在**你自己的电脑或服务器**上，使用**你自己申请的企业微信机器人、模型账号和工作目录**，运行本次企微适配版 botmux。无需申请本项目作者的账号、复用作者的机器人或再次 fork；直接克隆下面的公开分支即可。

按 0～9 顺序执行。每一步都有完成标准；遇到失败，修复当前步骤后再继续。命令面向 macOS / Linux 的 Bash；Windows 请先进入 WSL2。macOS 已有真实链路验收，Linux / WSL2 仍需在部署机器完成第 8 步，不能直接沿用作者的验收结论。

## 0. 可以直接发给你的 Agent 的任务

复制下面整段给具有本地终端权限的 Agent。它可以从公开 GitHub 读取本手册，无需访问作者的企业微信文档。

```text
请在我这台机器上独立部署 botmux 企业微信版，并实际完成消息收发验收。
先读取：
https://github.com/liuxiguang/botmux/blob/codex/wecom-support/docs/wecom-deployment-runbook.md
按其中 1～9 步执行，读取克隆仓库内适用的 AGENTS.md。

先检查我的 OS、工具版本、已有服务和目录；使用新的独立 clone、独立
stateDir、空闲 corePort。机器人、模型登录和允许访问的成员都使用我的配置。
默认先跑通本人单聊，再按我提供的测试群范围开放群聊。

可以安装缺少的依赖、构建、生成私有配置、启动本实例并查看本地日志。
仅在需要我创建机器人、扫码登录、在本地填写 Secret、确认测试成员或
从客户端发送测试消息时找我配合；先完成其余可独立进行的步骤。
Secret 由我写入本地私有文件，你只检查是否齐全，不要求我粘贴到聊天中。
保留已有服务与数据；启动和停止只针对本次创建的实例。

不要把编译通过、配置完整、进程存在或收到接收提示当成链路验收成功。
需要同时看到我的企微客户端收到最终答案，以及日志/账本对应任务完成、
最终结果投递成功。未实际执行的检查明确写“未验证”。

最终给我：实际 commit、工具版本、代码和配置路径、工作目录、后台会话名、
启动/停止/重启/日志命令、单聊及群聊验收结果。无需输出真实凭证或身份标识。
```

## 1. 本人和 Agent 各自准备什么

| 项目 | 负责人 | 完成标准 |
| --- | --- | --- |
| 运行机器及系统用户 | 本人选择，Agent 检查 | 机器能持续运行，能出站访问 GitHub、企业微信和模型服务 |
| 企业微信机器人 | 本人或企业管理员 | 已创建 API 模式、长连接机器人，保存 Bot ID / Secret，并允许本人使用 |
| Codex 登录 | 本人完成授权，Agent 检查 | 在运行 botmux 的同一系统用户下，一次本地 Codex 计算返回 323 |
| 允许的成员和群 | 本人确定，Agent 配置 | 从认证回调取得对应标识；只纳入已确认的成员及群 |
| 依赖、构建、配置、启动、日志 | Agent 或本人 | 按下文逐步检查并保留执行结果 |
| 客户端测试消息 | 本人，或已获授权操作客户端的 Agent | 实际收到最终结果，并与本地任务对应 |

机器人创建路径：企业微信「工作台 → 智能机器人 → 创建 → 手动创建 → API 模式 → 使用长连接」。如果没有此入口，请企业管理员协助。保存机器人并设置可使用成员范围；群测时把机器人加入内部测试群。申请的是**智能机器人长连接**，不是普通群 Webhook。操作界面参考[腾讯官方说明](https://cloud.tencent.com/document/product/1831/137051)。

同一机器人只运行一个连接服务。每个人独立部署时分别申请自己的机器人；迁移已有机器人时，先停掉它原来的 Demo 或服务。

本版 codex-app 执行器使用 `approvalPolicy: never`、`sandbox: danger-full-access`。允许的成员能通过机器人让 CLI 操作该系统用户有权限访问的文件；`workingDir` 只是默认工作目录。多人使用前选择合适的专用系统账号或实际隔离环境。

## 2. 检查并准备依赖

执行者：Agent 或本人。在将要运行 botmux 的同一系统用户下打开终端，执行 `bash` 进入 Bash。先检查已有工具，缺什么再安装什么。

```bash
uname -s
uname -m
command -v git bun node tmux python3 codex
git --version
bun --version
node --version
tmux -V
python3 --version
codex --version
```

要求：Git、**Bun 1.4.2**、**Node.js ≥ 22.13**、tmux、Python 3，以及本机 C/C++ 编译工具。Node 用于构建脚本，运行 botmux 使用 Bun。`node-pty` 可能需要本机编译；Linux 需准备编译器与 make。

macOS 缺编译工具时先运行 `xcode-select --install`，由本人完成系统安装窗口；已有 Homebrew 时可运行：

```bash
brew install git tmux python node@22
export PATH="$(brew --prefix node@22)/bin:$PATH"
```

没有 Homebrew 时按[官方安装说明](https://docs.brew.sh/Installation)安装。Ubuntu / Debian 可先准备系统工具：

```bash
sudo apt-get update
sudo apt-get install -y git tmux python3 build-essential curl unzip ca-certificates
```

Linux 的 Node 请按 [Node.js 官方下载页](https://nodejs.org/en/download)安装受支持的 LTS 版本；不要假定系统仓库里的旧版 Node 满足要求。已有 nvm/fnm 等版本管理器时沿用它，重新检查 `node --version`。

缺少指定 Bun 时，按 [Bun 官方指定版本安装方式](https://bun.sh/docs/installation)执行：

```bash
curl -fsSL https://bun.com/install | bash -s "bun-v1.4.2"
export PATH="$HOME/.bun/bin:$PATH"
bun --version
```

缺少 Codex 时，按 [OpenAI 官方 CLI 安装说明](https://learn.chatgpt.com/docs/codex/cli)执行安装器，并按它的提示设置 PATH：

```bash
curl -fsSL https://chatgpt.com/codex/install.sh | sh
```

**完成标准：**所有必需命令可以从当前 Bash 找到，Bun 和 Node 版本符合要求。保存版本输出供最后验收报告使用。代理、企业 CA 等网络设置沿用本机已验证配置；后台运行也要使用相同设置。

## 3. 固定本实例的路径，克隆并构建

以下变量是本手册所有命令共同使用的参数。可以修改前三个路径/名称，但应在第一次运行时确定；后续打开新终端时，重新执行这段并使用相同值。端口占用时换一个空闲的 1024～65535 端口。

```bash
export BOTMUX_INSTANCE="my-bot"
export BOTMUX_REPO="$HOME/apps/botmux-wecom"
export BOTMUX_WECOM_DIR="$HOME/.botmux/wecom/$BOTMUX_INSTANCE"
export BOTMUX_CORE_PORT="19321"
export BOTMUX_SERVICE="botmux-wecom-$BOTMUX_INSTANCE"
```

每个实例使用自己的代码目录、私有目录、服务名和端口。`BOTMUX_INSTANCE` 使用小写英文字母、数字、连字符。本文只新建独立 clone，不在其他人的 worktree 或共享 node_modules 上安装依赖。

```bash
if [ -e "$BOTMUX_REPO" ] || [ -L "$BOTMUX_REPO" ]; then
  echo "代码目录已存在：先核对是否为本实例；新部署请另选目录。"
else
  mkdir -p "$(dirname "$BOTMUX_REPO")"
  git clone --branch codex/wecom-support --single-branch \
    https://github.com/liuxiguang/botmux.git "$BOTMUX_REPO"
fi
```

**若上面提示目录已存在，先处理目录选择，不要继续安装。** 新 clone 成功后：

```bash
cd "$BOTMUX_REPO"
git branch --show-current
git rev-parse HEAD
bun install --frozen-lockfile
bun run build
bun dist/cli.js wecom --help
```

每条命令都必须成功才执行下一条。保留 `trustedDependencies` 中的 electron 和 node-pty。若 install/build 失败，先解决网络、编译工具或版本问题，不要继续启动。

**完成标准：**分支为 `codex/wecom-support`，构建退出码为 0，帮助中显示 `wecom <serve|check-config> --config`；记录实际 commit。直接装 npm 正式版或克隆 master 不等于取得本次企微功能。

## 4. 登录自己的 Codex，并验证它能工作

先创建新的私有实例目录：

```bash
umask 077
mkdir -p "$BOTMUX_WECOM_DIR/project" "$BOTMUX_WECOM_DIR/state"
chmod 700 "$BOTMUX_WECOM_DIR"
codex login status
```

尚未登录时运行 `codex login`，由本人完成浏览器授权。远程无浏览器机器可按[官方认证说明](https://learn.chatgpt.com/docs/auth)使用 `codex login --device-auth`，前提是账号允许设备码登录。

```bash
codex app-server --help
codex exec --skip-git-repo-check --sandbox read-only \
  -C "$BOTMUX_WECOM_DIR/project" "计算 17×19，只返回结果，不执行其他操作。"
```

**完成标准：**app-server 子命令可用，实际模型请求成功，最终答案为 323。模型无权限、额度不足或网络错误都应在这一层先修复。无需打开 Codex 桌面窗口。

默认沿用当前系统用户的 Codex 登录及配置。若部署者已经选择独立 CODEX_HOME，应从登录开始就使用它，并保持后面的启动环境一致；新建一个空目录不会自动获得登录凭证。

## 5. 本人在本机填写机器人凭证

下面只创建空文件，不打印凭证。已有同名配置时，先确认是本实例需要复用的文件。

```bash
touch "$BOTMUX_WECOM_DIR/wecom.env"
chmod 600 "$BOTMUX_WECOM_DIR/wecom.env"
```

本人用本地编辑器打开这个文件（例如 `nano "$BOTMUX_WECOM_DIR/wecom.env"`），填入实际值并保存。以下是格式示意，不要把占位词原样保存后继续：

```dotenv
WECOM_BOT_ID=REPLACE_WITH_YOUR_BOT_ID
WECOM_BOT_SECRET=REPLACE_WITH_YOUR_BOT_SECRET
```

Agent 只需检查文件存在、权限与字段是否填写，无需向聊天回显完整文件。模型账号凭证不填在这里，这个文件只负责企业微信长连接认证。

**完成标准：**两项实际凭证已保存到本机私有文件，原机器人连接服务已停止。凭证是否有效由下一步认证验证，非空并不代表有效。

## 6. 取得本人/群的标识，生成访问配置

执行者：Agent 启动只读诊断，本人发测试消息。以下操作在代码根目录执行，诊断期间不要同时启动正式服务。先清除当前 Shell 残留的企微环境变量，让指定 env 文件生效：

```bash
cd "$BOTMUX_REPO"
unset WECOM_BOT_ID WECOM_BOT_SECRET
bun --env-file "$BOTMUX_WECOM_DIR/wecom.env" -e '
import { WSClient } from "@wecom/aibot-node-sdk";
import { ProxyAgent } from "proxy-agent";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
const id = process.env.WECOM_BOT_ID?.trim();
const secret = process.env.WECOM_BOT_SECRET?.trim();
if (!id || !secret || [id, secret].some(v => v.startsWith("REPLACE_"))) {
  throw new Error("请先在本地填写真实凭证");
}
const client = new WSClient({ botId: id, secret,
  logger: { debug() {}, info() {}, warn() {}, error() {} },
  wsOptions: { agent: new ProxyAgent() } });
let ready = false;
client.on("authenticated", () => {
  ready = true; console.log("已认证：请本人单聊测试，需要群聊时再在目标群 @机器人测试");
});
client.on("disconnected", () => { ready = false; });
client.on("message", frame => {
  const b = frame.body;
  if (!ready || b?.aibotid !== id || !b.from?.userid) return;
  const record = { time: new Date().toISOString(), sender: b.from.userid,
    chat: b.chatid, type: b.chattype };
  appendFileSync(join(process.env.BOTMUX_WECOM_DIR, "identity-observations.jsonl"),
    JSON.stringify(record) + "\n", { mode: 0o600 });
  console.log("已记录一次认证消息的元信息；请按发送时间在本机核对");
});
client.on("error", () => console.error("连接错误：检查凭证和网络"));
process.on("SIGINT", () => { client.disconnect(); process.exit(0); });
client.connect();
'
```

看到“已认证”后，本人向自己的机器人单聊发送 `登记本人`；要开放群聊时，在已加入机器人的内部测试群 @机器人发送 `登记测试群`。此诊断**不回复消息、不执行 CLI**，只把发送时间及发送者/群标识保存到私有目录。本人或 Agent 在本机核对 `identity-observations.jsonl`，用本人实际发送时刻匹配记录。完成后按 Ctrl+C 停止诊断。

创建初始配置（已有 config.json 时不会覆盖）：

```bash
python3 - <<'PY'
import json, os
from pathlib import Path
base = Path(os.environ['BOTMUX_WECOM_DIR'])
config = {
    'botName': 'REPLACE_WITH_BOT_DISPLAY_NAME',
    'workingDir': './project', 'stateDir': './state', 'envFile': './wecom.env',
    'corePort': int(os.environ['BOTMUX_CORE_PORT']), 'cliId': 'codex-app',
    'allowedUsers': ['REPLACE_WITH_AUTHENTICATED_SENDER'],
    'adminUsers': ['REPLACE_WITH_AUTHENTICATED_SENDER'],
    'allowedChats': [], 'maxConcurrent': 2, 'maxQueuedPerChat': 20
}
p = base / 'config.json'
with p.open('x') as f:
    f.write(json.dumps(config, ensure_ascii=False, indent=2) + '\n')
p.chmod(0o600)
print('初始配置已创建，请完成本机替换。')
PY
```

编辑 `config.json`：

| 字段 | 填写方式 |
| --- | --- |
| botName | 本人机器人在企微里当前显示的名称 |
| allowedUsers | 把本人认证消息的 sender 填入数组；增加他人需先确认授权并取得其真实 sender |
| adminUsers | 初次只填本人，同一个值也必须在 allowedUsers 中 |
| allowedChats | 先保留空数组跑通单聊；开放群时加入该群认证消息的 chat |
| workingDir | 默认保留 ./project；指定已有项目时换成该项目绝对路径并核对文件权限 |

成员标识与群标识不能互换，不能从昵称猜测，也不能填写 `*`。这里的身份数据来自你自己的机器人，与作者环境无关。

**完成标准：**诊断连接已退出；JSON 中所有 `REPLACE_` 占位内容均已替换；管理员同时在成员白名单。群聊必须同时允许该群和发送者。

## 7. 校验并前台启动

先检查占位符、目录和端口；此脚本不输出身份标识或凭证：

```bash
python3 - <<'PY'
import json, os, socket
from pathlib import Path
base = Path(os.environ['BOTMUX_WECOM_DIR'])
c = json.loads((base / 'config.json').read_text())
assert 'REPLACE_' not in json.dumps(c), '请替换配置中的占位符'
assert (base / c['workingDir']).is_dir(), '工作目录不存在'
assert c['allowedUsers'] and set(c['adminUsers']) <= set(c['allowedUsers']), '白名单配置有误'
with socket.socket() as s:
    s.bind(('127.0.0.1', c['corePort']))
print('占位符、工作目录和端口检查通过')
PY
cd "$BOTMUX_REPO"
bun dist/cli.js wecom check-config --config "$BOTMUX_WECOM_DIR/config.json"
```

必须看到 `企微配置完整；尚未联网验证凭证或执行 CLI。` 再继续。端口占用时修改 config.json 的 corePort，重新检查；不要结束不属于本实例的占用进程。

```bash
set -o pipefail
bun dist/cli.js wecom serve --config "$BOTMUX_WECOM_DIR/config.json" \
  2>&1 | tee -a "$BOTMUX_WECOM_DIR/bridge.log"
```

**完成标准：**本次启动日志同时出现 `[wecom] authenticated` 与 `[wecom] ready`，进程仍运行。首次 core-only 启动可能等待一段时间；失败查看 `state/core.log`。继续保持此终端运行，另开终端进行第 8 步。

使用的是企微专用 `wecom serve`；`botmux setup/start`、飞书 `daemon:restart` 不负责启动本实例。源码版运行期间不要清理或重新生成正在使用的 dist。

## 8. 真正完成消息链路验收

执行者：本人发消息，Agent 检查日志；只有本人明确授权操作客户端时，Agent 才代发测试消息。新终端先重新设置第 3 步变量。

```bash
tail -n 80 "$BOTMUX_WECOM_DIR/bridge.log"
tail -n 80 "$BOTMUX_WECOM_DIR/state/core.log"
```

| 测试 | 本人操作 | 完成标准 |
| --- | --- | --- |
| 单聊执行 | 发送“计算 17×19，只返回结果” | 先接收提示，再收到最终答案 323 |
| 连续上下文 | 发送“记住测试词海风529”，再问“刚才的测试词是什么” | 最终回复包含海风529 |
| 状态命令 | 发送 /status | 收到任务和投递状态 |
| 新上下文 | 任务空闲时由管理员发送 /new | 下一条任务创建新会话；日志/账本中的映射改变 |
| 群聊（若启用） | 白名单成员在白名单群中 @机器人发计算题 | 群内收到最终结果；群与单聊映射不同 |
| 群共享（若启用） | 两位已授权成员先后设置、追问测试词 | 两人的消息使用同一个群会话；不能用一个人测试冒充多人验证 |

日志中按同一个本地任务编号找到 `received → submitted → completed → delivered`。接收提示和最终回答都会产生投递事件；必须核对**最终回答**的投递。

安装了 sqlite3 时可只读查询，区分最终结果与接收提示：

```bash
sqlite3 -readonly "$BOTMUX_WECOM_DIR/state/wecom.sqlite" \
  'SELECT id, phase, sessionId FROM messages ORDER BY id DESC LIMIT 10;'
sqlite3 -readonly "$BOTMUX_WECOM_DIR/state/wecom.sqlite" \
  'SELECT messageId, kind, ordinal, state, attempts FROM outbox ORDER BY id DESC LIMIT 20;'
```

**完成标准：**实际客户端最终回答与本地对应任务均已确认。若只有配置检查、编译或接收提示成功，状态应写“部署中，链路未验收”。若没有条件测群，明确写“单聊通过，群聊未验证”。

## 9. 后台运行、停止、重启与更新

前台验收通过后，在前台终端按 Ctrl+C 停止，确认退出再切后台；不要并行启动第二个连接。下面采用跨 macOS/Linux 的 tmux 后台方式：关闭普通终端后仍运行，**机器重启后需重新启动，也不负责崩溃自动拉起**。

在刚才已验证 Codex 和网络正常的终端中生成私有启动脚本。脚本固定真实路径、Codex 配置目录与代理/CA 环境，避免后台的 PATH 不同：

```bash
python3 - <<'PY'
import os, shlex, shutil
from pathlib import Path
repo = Path(os.environ['BOTMUX_REPO']).resolve()
base = Path(os.environ['BOTMUX_WECOM_DIR']).resolve()
bun = shutil.which('bun')
assert bun and shutil.which('codex') and shutil.which('tmux'), '请先修复 PATH'
q = shlex.quote
lines = ['#!/bin/bash', 'set -euo pipefail', 'umask 077',
         'export PATH=' + q(os.environ['PATH']),
         'export CODEX_HOME=' + q(str(Path(os.environ.get('CODEX_HOME', '~/.codex')).expanduser().resolve())),
         'unset WECOM_BOT_ID WECOM_BOT_SECRET']
for key in ('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
            'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
            'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'CODEX_CA_CERTIFICATE'):
    lines.append('export ' + key + '=' + q(os.environ[key]) if key in os.environ else 'unset ' + key)
lines += ['cd ' + q(str(repo)),
          'exec ' + q(bun) + ' ' + q(str(repo / 'dist/cli.js'))
          + ' wecom serve --config ' + q(str(base / 'config.json'))
          + ' >>' + q(str(base / 'bridge.log')) + ' 2>&1']
p = base / 'run.sh'
p.write_text('\n'.join(lines) + '\n')
p.chmod(0o700)
print('私有启动脚本已生成；不含企微 Secret。')
PY
bash -n "$BOTMUX_WECOM_DIR/run.sh"
```

如果机器已经有相同服务名，先检查它而不是重复创建：

```bash
if tmux has-session -t "=$BOTMUX_SERVICE" 2>/dev/null; then
  echo "本实例后台会话已存在，请检查日志或连接查看。"
else
  tmux new-session -d -s "$BOTMUX_SERVICE" /bin/bash "$BOTMUX_WECOM_DIR/run.sh"
fi
tail -n 80 "$BOTMUX_WECOM_DIR/bridge.log"
```

后台启动后重新执行第 8 步的单聊计算。看到旧日志的 ready 不算本次成功，要核对新启动时间、认证事件和新任务。

日常操作（新终端先重设第 3 步变量）：

```bash
# 查看本实例后台终端；Ctrl+B 再 D 退出查看，不停止服务
tmux attach -r -t "=$BOTMUX_SERVICE"

# 持续查看日志；Ctrl+C 只结束 tail
tail -f "$BOTMUX_WECOM_DIR/bridge.log"

# 停止：仅向本实例主窗口发 Ctrl+C，等待它优雅退出
tmux send-keys -t "=$BOTMUX_SERVICE:0.0" C-c

# 检查是否已退出；返回非 0 表示后台会话不存在
tmux has-session -t "=$BOTMUX_SERVICE"
```

确认服务会话退出后，再执行上面的后台启动块即可重启。`botmux-wecom-...` 是本文创建的桥接服务终端；`bmx-...` 是 botmux 创建的任务终端，停止桥接服务不等于删除任务终端和历史。不要用 `tmux kill-server` 停止一个实例。

需要开机自启动或失败重启时，部署 Agent 应按当前 OS 创建 launchd（macOS）或 systemd（Linux）服务，入口为本实例 `run.sh`，使用同一系统用户、HOME 和配置；替换 tmux 托管前先停 tmux 服务。只有实际测试了注销/重启后的新任务，才报告“自启动已验证”。

更新源码前等待任务结束并停止本实例，保存当前 commit。工作区有本地修改时先处理修改；只在这个独立 clone 安装：

```bash
cd "$BOTMUX_REPO"
git status --short
git rev-parse HEAD
# 上面确认工作区干净、服务已停止后再继续
git pull --ff-only origin codex/wecom-support
bun install --frozen-lockfile
bun run build
bun dist/cli.js wecom check-config --config "$BOTMUX_WECOM_DIR/config.json"
```

全部成功后再后台启动并重测 323。失败时保留私有目录及 SQLite 账本；代码回退使用之前记录的 commit 另建部署目录重新构建，再调整 run.sh，不能把清空 stateDir 当成修复。

## 交付报告：Agent 必须告诉部署者什么

```text
部署状态：单聊通过 / 群聊通过或未验证 / 后台运行通过或未验证
系统与版本：OS、Bun、Node、tmux、Codex
代码：实际仓库路径、分支、commit
配置：config.json / wecom.env / state / workingDir 的实际路径（不含真实内容）
运行：本实例后台会话名、实际启动/停止/重启/日志命令
证据：测试时间、题目和最终答案、对应任务完成与最终投递状态
限制：尚未验证的平台/多人场景、是否支持并验证自启动
待本人完成：如有，列出确切步骤及阻塞原因
```

本手册命令与脚本需在每台机器分别验收。作者环境的验收结果和架构说明见[适配原理与本地部署指南](https://github.com/liuxiguang/botmux/blob/codex/wecom-support/docs/wecom-onboarding.md)，它们不能替代部署者自己的端到端测试。
