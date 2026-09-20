# 企业微信智能机器人

首次部署可先阅读 [适配原理与本地部署指南](wecom-onboarding.md)，包含机器人申请、白名单获取、启动和排查步骤。

企业微信单聊或内部群内 @机器人可以向 botmux 提交文本任务。机器人通过官方 `@wecom/aibot-node-sdk` 长连接收发，专用 core-only 进程复用现有 CLI 执行、异步结果和恢复机制。

**同一群的获准成员共享一个 CLI 会话，输入串行执行。** 不同群及不同单聊用户隔离上下文；共享工作目录中的文件仍可互相影响。本阶段提供接收确认和最终结果，不提供逐 token 输出、飞书卡片、媒体输入、CLI 权限按钮或远程终端授权。

## 企业微信配置

1. 创建智能机器人，选择 API 模式中的长连接，取得 Bot ID 和 Secret。
2. 配置成员可使用范围，并把机器人加入内部测试群。
3. 同一个机器人只运行一个连接服务。由旧 Demo 迁移时先停止旧进程。

长连接不需要公网回调 URL。服务器需允许出站访问 `wss://openws.work.weixin.qq.com`；遵循宿主代理环境变量。参考 [官方 SDK](https://github.com/WecomTeam/aibot-node-sdk) 和 [长连接协议](https://developer.work.weixin.qq.com/document/path/101463)。

## 本地配置

使用已有受支持的 CLI 并完成其本地登录。源代码 checkout 先运行 `bun run build`。

将 [配置示例](../examples/wecom/config.example.json) 保存到仓库外的私有目录。`workingDir` 必须存在，相对路径均以配置文件所在目录为基准。`stateDir` 保存 SQLite 账本、执行服务状态和 `core.log`，不要与已有 daemon 共用。`corePort` 必须是空闲本地端口。

`wecom.env` 内容：

```dotenv
WECOM_BOT_ID=填写机器人标识
WECOM_BOT_SECRET=填写长连接密钥
```

将配置和 env 文件权限设为 `0600`，不要提交真实配置。进程环境变量优先于 env 文件。`botName` 填机器人当前显示名，供群内 `@机器人 /status` 等命令去掉前导 mention；它不用于身份验证。

- `allowedUsers`：可提交任务的真实企微回调发送者标识；必填，不支持通配符。
- `allowedChats`：允许接入的群标识；默认空数组，禁止所有群，只允许已获准用户单聊。
- `adminUsers`：可执行 `/new` 的用户，必须属于 allowedUsers。
- userid/chatid 必须来自已认证回调或受信管理工具，不能按昵称猜测。应用可使用范围与本地 allowlist 均需满足。
- `cliId` 默认为 `codex-app`，`model` 可选；并非全部 CLI/后端组合都已经实测。

配置检查不联网：

```bash
bun dist/cli.js wecom check-config --config /absolute/path/config.json
```

前台启动（Ctrl+C 优雅停止）：

```bash
bun dist/cli.js wecom serve --config /absolute/path/config.json
```

已安装的编译版使用 `botmux wecom ...`。出现 `[wecom] authenticated` 和 `[wecom] ready` 才表示连接与执行服务均就绪。源码开发时必须使用本 checkout 的 `dist/cli.js`，避免 PATH 中的旧版本。

企微入口独立管理自己的 core-only 子进程。飞书 fleet 的 `daemon:restart` 不管理这个前台服务；生产部署可由 launchd/systemd 托管上述命令。需要更新时先构建，再停止旧企微进程并启动新版本；不要启动同机器人第二个副本来“滚动更新”。

## 消息与命令

在单聊直接发文字；群里 @机器人后发文字。机器人先确认任务编号，完成后主动回传到原会话；长答案按 UTF-8 字节拆分为多条，并带相同任务编号。

- `/help`：使用说明。
- `/status`：最近任务的执行状态、排队数量、结果投递状态。
- `/new`：管理员在会话没有运行/排队任务时建立新上下文；不删除历史，也不取消仍在执行的任务。

默认最多同时执行 2 个不同会话，每个会话最多 20 个未完成任务；可以通过 `maxConcurrent` 和 `maxQueuedPerChat` 调整。默认超出一小时的运行会在状态里标注超时，但仍查询原任务，不重复执行、不擅自启动同会话下一轮。

未获准消息不会交给 CLI。群内结果用短任务编号和发送者的稳定匿名标记区分。成员共享 CLI 的操作权限，不会自动继承每个人的企微个人授权。

## 恢复与边界

- 输入落盘后才确认接收，回调按机器人和 msgid 去重。
- 提交超时重试同一幂等键；重启恢复保存的请求及精确 triggerId。
- 执行完成和结果发送分别记录。发送未收到回执时标记“发送结果未知”，不无界重发。
- 重启时，已经进入发送但尚未保存回执的记录同样视为未知；因此不能保证结果绝对不漏、不重复。
- 明确执行失败或 session 不存在时暂停会话，排队任务标记未执行；管理员确认后 `/new`。
- SDK 重连不代表平台会补发离线消息。只有本地已保存消息纳入恢复保证。
- 本地对每会话控制到每分钟 20 次、每小时 800 次投递尝试（包含接收提示和重试）；超过配额保留待发送状态。
- 单机按机器人加进程锁；被平台连接顶替后退出，不竞争重连。跨主机由部署方保证单活。
- CLI 不继承企微 Secret；core-only 控制端口限制为 loopback。它仍是同机信任接口，文件权限也不隔离同一 OS 用户，执行权限和工作目录范围须按部署需求配置沙盒。
- 接入日志只输出阶段和本地任务编号；执行进程详细日志在 stateDir/core.log。SQLite 中包含任务与回答，应按业务要求保存或清理。

## 开发验证

```bash
bun run test -- test/wecom-config.test.ts test/wecom-message.test.ts test/wecom-store.test.ts test/wecom-bridge.test.ts test/wecom-core-client.test.ts test/wecom-transport.test.ts test/wecom-runtime.test.ts
bun run build
```

协议测试使用真实官方 SDK 与本地 WebSocket fixture，不需要线上凭证。真实环境验收还需检查：企微入站落盘、实际 CLI 完成、平台发送回执、界面收到结果、同群追问使用相同上下文。
