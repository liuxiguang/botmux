# 企业微信接入实施计划

> 执行方式：使用 superpowers:executing-plans 在本任务连续实施，最后进行独立审查。用户已明确授权实施、自行部署和通过企业微信 UI 发送测试消息。

**Goal:** 企业微信单聊及群内 @能运行真实 CLI、续接上下文并收到最终结果。

**Architecture:** 官方 Node SDK 管理长连接；独立 SQLite 保存共享会话、输入队列及结果投递。接入进程启动专用 core-only 子进程，通过已有 trigger API 驱动 CLI，不重构飞书实现。

**Tech Stack:** TypeScript、Bun 1.4.2、Node >=22.13、SQLite、@wecom/aibot-node-sdk。

**Spec:** [设计方案](../design/2026-09-20-wecom-support-design.md)

## Global Constraints

- 群内共享一个 CLI 会话，单聊按人隔离；所有状态和幂等键含 bot 身份。
- 不在 worktree 执行 bun install；新依赖在外部暂存目录安装，使用独立 node_modules。
- 保留 trustedDependencies 的 electron/node-pty；不改 package.json.version。
- 源码与编译态通过 resolveEntrySpawn 启动子进程；测试 spawn 走 ts-runner helper。
- 不外露凭证，企微 Secret 不传给 core-only/worker；不扩开免 HMAC 管理路由。
- 测试失败如实报告；部署后查看实际子进程状态和消息回执。

## Review Focus

1. submit 成功但响应丢失：重启/重试不能再次运行任务。
2. 两人同群同时发消息：同 session、串行、结果不会串到下一轮。
3. ACK 丢失：执行完成不等于已发送，不自动无限重发未知投递。
4. 重启与 /new：未处理旧队列不能跨代次执行，未知会话状态不得自动重跑。
5. SDK 认证失败、连接被顶替、core-only 端口冲突：及时退出且不泄露凭证、不误接其他实例。

### Task 1: 配置与消息边界

**Files:** src/im/wecom/config.ts、message.ts；test/wecom-config.test.ts、wecom-message.test.ts。

**Interfaces:**

```ts
parseWecomConfig(raw: unknown, baseDir: string): WecomConfig
loadWecomConfig(path: string, env?: NodeJS.ProcessEnv): LoadedWecomConfig
normalizeMessage(frame: unknown, botId: string): WecomMessage | null
conversationKey(message: WecomMessage): string
isAllowed(message: WecomMessage, config: WecomConfig): boolean
splitUtf8(text: string, maxBytes: number): string[]
```

- [x] 写失败测试：缺失凭证不回显 secret，未知字段拒绝，相对路径规范化，单聊与群聊路由，两个发送者同群同键，跨 bot 不同键，UTF-8 多字节分片完整。
- [x] 运行 `bun run test -- test/wecom-config.test.ts test/wecom-message.test.ts`，确认新行为尚未实现。
- [x] 配置用 zod 严格解析；消息只接受已验证 envelope 中必需的 string 字段，群 chatId 必填；队列和并发范围约束。
- [x] 运行以上测试至通过，准备独立依赖安装目录并加入锁定 SDK。

### Task 2: 持久化队列与执行协议

**Files:** src/im/wecom/store.ts、core-client.ts、bridge.ts；test/wecom-store.test.ts、wecom-bridge.test.ts。

**Interfaces:**

```ts
class WecomStore { constructor(path: string); close(): void; }
interface CoreClient {
  submit(request: TriggerRequest): Promise<TriggerResponse>;
  result(sessionId: string, triggerId: string): Promise<TriggerResponse>;
}
class WecomBridge {
  accept(frame: unknown): Promise<void>;
  tick(): Promise<void>;
  stop(): Promise<void>;
}
```

- [x] 写失败测试，使用真实临时 SQLite 与本地 HTTP fixture。发送两名用户的群消息，预期 submit 依次出现，续轮指向相同 sessionId；重复 msgid 只运行一次。
- [x] 加入丢失 submit 响应、重开数据库、精确 triggerId 查询、failed/not_found、/new 管理权限和忙时拒绝测试。
- [x] 实现事务化入站插入、固定 submit 请求、执行/投递分离状态及恢复。session 未知时暂停该会话，等待管理员 /new。
- [x] 使用已有 asyncReturnSessionId 与幂等键；503/网络错误有限退避，明确拒绝不自动重新创建任务。
- [x] 运行 `bun run test -- test/wecom-store.test.ts test/wecom-bridge.test.ts` 至通过。

### Task 3: SDK 传输、命令与进程生命周期

**Files:** src/im/wecom/transport.ts、runtime.ts；src/cli/wecom-command.ts、src/index-wecom.ts；src/cli.ts、src/core/self-spawn.ts；test/wecom-transport.test.ts、wecom-runtime.test.ts。

**Interfaces:**

```ts
interface WecomTransport {
  reply(message: WecomMessage, content: string): Promise<void>;
  send(message: WecomMessage, content: string): Promise<void>;
}
runWecom(configPath: string): Promise<void>
runWecomCommand(args: string[]): Promise<void>
```

- [x] 用真实 SDK + 本地 WebSocket 服务测试认证、消息回调、回复/主动发送 ACK、超时与非零 errcode。
- [x] 测试 outbox 分片发送、会话限流、sending 状态重启后标记未知、认证超时、顶替事件停机。
- [x] 测试临时端口占用时启动失败，子进程 env 不含企微凭证和 session owner；SIGTERM 清理连接和进程。
- [x] 实现 SDK 日志过滤、单 bot 进程锁、子进程 ready/exit 管理及清理；注册 wecom/check-config/serve 和编译态入口。
- [x] 运行 `bun run test -- test/wecom-transport.test.ts test/wecom-runtime.test.ts` 至通过。

### Task 4: 文档、全量检查与部署验收

**Files:** docs/wecom.md、examples/wecom/config.example.json、README.md、scripts/smoke-bun-binary.mjs（按入口需要）。

- [x] 编写不含凭证的安装、配置、运行与限制说明，明确群共享和文件权限边界。
- [x] 运行 `bun run build`、相关回归及 `bun run test`，将完整日志存于本计划的临时工作目录；记录基线失败而不隐去。
- [x] 运行 `bun run build:bun`，用编译产物执行 check-config，并实际部署验证长连接、核心进程和 CLI 子进程。
- [x] 在本机创建独立运行配置，使用引用 Demo 的同一机器人前确认原进程并停掉该 Demo；配置来自本地受保护文件，避免输出值。
- [x] 按仓库规范部署重启，查看实际进程和日志；启动企微入口并确认认证。
- [x] 使用 computer use 控制企业微信，向已识别的测试群 @机器人发送无副作用任务，随后追问记忆标记。验证入站持久化、CLI 实际输出与企业微信回执；测试 /status、/new 和重启后续接。
- [x] 独立审查新代码，修复影响正确性的发现并复测；交付分支、运行方法、实测结果及仍未验证的组合。

## 执行记录

- 初始基线：相关 116 项测试及 bun run build 通过。
- 用户已授权完整实施、部署、企微 UI 发消息测试；不额外设置计划审批停点。

- 实施、审查及部署验收完成。详见 [验收记录](../wecom-validation.md)。官方 SDK 为 1.0.7；静默完成问题一并修复。
