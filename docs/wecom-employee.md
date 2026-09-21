# 用员工账号接入 botmux

员工模式使用已授权的 `wecom-cli` 查询会话，并用 `message send` 发送文本。机器人模式仍然使用官方 WebSocket。两者身份和状态目录独立。

2026-09-21 当前测试账号已验证：CLI 发送后，回读消息的发送者与授权员工一致；两个员工单聊的近期测试消息也能读取。不同企业/授权的能力可能不同，部署到其他账号必须重复验证，不能仅凭 CLI 的通用身份说明推断发送者。

## 人需要做什么

1. 完成自己的 `wecom-cli` 授权和 Codex 登录。
2. 指定允许自动处理的联系人和群。首次只开放一个测试群。
3. 如需平台回调，让管理员开通**会话内容存档**并配置“产生会话回调事件”。把 Token、EncodingAESKey 和企业 CorpID 填入本机私有 env 文件。机器人 Bot ID / Secret 不是这里的凭证。
4. 在测试群发送 `/codex 计算 17×19，只回复结果`，核对回复的员工头像、姓名和结果。

没有存档回调配置时，可以先轮询使用。默认每轮完成后等待 30 秒；这是本项目默认值，不是企微 QPS 保证。企业后台无法访问或权限未开通时，不能声称已实现真实平台推送。

## Agent 需要做什么

1. 使用仓库 `codex/wecom-support` 分支，检查 `wecom-cli >= 1.3.0` 且授权状态为 authorized。
2. 调用 `identity whoami` 识别授权员工。通过联系人查询、群查询取得新鲜标识，写入私有配置；不要把真实标识、凭证或聊天内容提交 Git。
3. 向本人指定的测试会话发送一条明确标注的验证消息，并回读确认发送者确实是该员工。
4. 使用独立工作目录、状态目录和空闲端口，构建并启动下方配置。运行中会检查身份，发送前也会检查。身份查询与发送是两个调用，运行期间不要在同一 CLI 配置目录切换授权账号；需要切换时先停服务。
5. 核对日志 `employee_identity_verified`、`ready`、`received`、`submitted`、`completed`、`delivered`，再从企微读到最终回复。仅有 CLI exit 0 或“已接收任务”不算完整验收。
6. 单独报告：群/私聊、轮询/真实回调、发送身份和 Codex 执行，各自哪些已实测。

## 最小配置

以下均为占位值。单聊的会话标识使用对方成员标识，不是自己的；目前群列表不会枚举全部私聊。仅配置会话会被采集。

```json
{
  "mode": "employee",
  "workingDir": "./project",
  "stateDir": "./state",
  "corePort": 19631,
  "cliId": "codex-app",
  "allowedUsers": ["OWNER_USER_ID", "PEER_USER_ID"],
  "adminUsers": ["OWNER_USER_ID"],
  "allowedChats": ["TEST_GROUP_ID"],
  "employee": {
    "userId": "OWNER_USER_ID",
    "cliPath": "wecom-cli",
    "chats": [
      { "chatId": "PEER_USER_ID", "chatType": "single", "name": "指定同事" },
      { "chatId": "TEST_GROUP_ID", "chatType": "group", "name": "测试群" }
    ],
    "pollIntervalMs": 30000,
    "requestIntervalMs": 1000
  }
}
```

全新本地部署先准备 Bun 1.4.2、tmux、Codex CLI 和已授权的 wecom-cli，再克隆独立目录：

```bash
git clone --branch codex/wecom-support https://github.com/liuxiguang/botmux.git
cd botmux
bun install --frozen-lockfile
```

以上安装命令只用于独立克隆；已有 worktree 不执行 install，遵循仓库依赖规则。创建配置中的 `project` 目录，再执行：

```bash
bun run build
bun dist/cli.js wecom check-config --config /absolute/private/config.json
bun dist/cli.js wecom serve --config /absolute/private/config.json
```

也可用本分支编译的单文件版本运行 `botmux-wecom wecom serve --config ...`。停止进程会停止本实例的采集和 core-only 子进程。

- 默认私聊：白名单成员发来的文本直接进入 Codex；按联系人隔离会话。
- 默认群聊：只有以 `/codex ` 开头的消息才进入 Codex，同一群共享上下文。可以在单个会话上设置非空 `prefix`。
- 本人发出的普通消息和系统回传的回复都会忽略。本人的 `/codex ` 消息是显式自测/指令入口，可用 `ownMessagePrefix` 修改。
- `/codex /status` 查看测试群任务状态，`/codex /new` 由管理员在空闲时开启新会话。
- 首次启动不处理旧聊天；重启沿持久化水位追赶。不要随意删除状态目录。
- CLI 当前没有返回稳定消息 ID，本实现使用内容指纹和同秒重复计数；不能保证任意历史改写情况下绝不重发。默认向前重读 2 分钟（`overlapMs`），晚于这个窗口才可见的消息可能漏采，可按实际延迟增大窗口。超过 7 天的停机历史缺口会停止服务并要求人工处理。
- CLI 查询、身份检查与发送统一串行限速，限流后退避；发送结果未知时不会盲目重发。空轮询不会调用 Codex。
- 暂支持文本消息。默认配置不隔离 Codex 的全局登录、插件和本机文件权限，授权成员拥有本实例的执行能力。

## 接入企业微信回调

这条链路是 **HTTP 通知唤醒 CLI 采集**，不是员工 WebSocket，也不是通过存档 SDK 解密全部聊天内容。回调开通范围和 CLI 可读范围必须分别满足条件。

在主配置增加 `"envFile": "./callback.env"`，在 `employee` 中增加：

```json
{
  "callback": {
    "host": "127.0.0.1",
    "port": 19632,
    "path": "/wecom/employee/callback"
  }
}
```

私有 `callback.env`：

```dotenv
WECOM_CALLBACK_TOKEN=从企业后台配置取得
WECOM_CALLBACK_AES_KEY=从企业后台取得的43位EncodingAESKey
WECOM_CALLBACK_CORP_ID=你的企业CorpID
```

将自己的公网 HTTPS 地址反向代理到 `127.0.0.1:19632/wecom/employee/callback`，再填入企业后台的存档回调设置。服务支持 GET 验证和加密 XML POST，校验签名、企业身份、时间与重放，只接受 `msgaudit_notify`。

日志 `employee_callback_listening` 只表示本地端口已监听。后台 URL 验证成功、收到真实消息后日志出现 `employee_callback_received`，并完成最终回复，才算平台回调验收成功。

官方存档通知间隔为 15 秒。回调到达会尽快唤醒采集，但仍遵守全局限速和失败退避。保留 `pollIntervalMs` 的周期补拉，可以设为 60000～300000 毫秒；真实延迟还取决于 CLI 数据可见时间和 Codex 处理时间。

官方来源：[产生会话回调事件](https://developer.work.weixin.qq.com/document/path/95039)、[回调加解密](https://developer.work.weixin.qq.com/document/path/90968)、[CLI 命令参考](https://github.com/WecomTeam/wecom-cli/blob/main/docs/cli-reference.md)。


## 本次验证记录（2026-09-21）

- macOS arm64、Bun 1.4.2、wecom-cli 1.3.0：TypeScript 构建及单文件编译成功，15 个相关测试文件共 160 项通过，覆盖员工采集/回调、原机器人桥接、飞书边界和 core-only 幂等。
- 专用测试群、仅账号本人触发、10 秒轮询：`17×19` 返回 `323`；SQLite 任务 completed、出站 sent；从企业微信回读最终消息，确认发送者为已授权员工。
- 正常停机再启动后，旧指令未新增任务、最终回复未重复；追问上一轮的数字返回 `17和19`，两轮使用同一个 Codex 会话。
- 加密回调的 GET 验证、POST 通知、重放及错误签名等已通过本地 HTTP 测试；**未配置企业管理员的真实存档回调，未完成平台回调验收**。当前已部署实例运行轮询模式。
- 私聊历史读取已验证；他人主动私聊后的自动回复、其他企业账号、Linux 实机及完整全仓测试未在本次验收。
