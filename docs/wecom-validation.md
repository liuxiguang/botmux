# 企业微信接入验收记录

日期：2026-09-20；基线：`787df835`；分支：`codex/wecom-support`。

## 自动化检查

- 初始基线：headless、apiOnly、飞书传输边界、首轮和续轮幂等共 116 项通过。
- 新增企微测试：7 个文件、28 项通过。涵盖配置、身份与路由、真实 SQLite、丢响应重试、串行共享会话、未知投递、跨群限流、本地 HTTP、真实官方 SDK 连接本地 WebSocket、进程生命周期。
- 最终企微与 headless/apiOnly/飞书传输及幂等回归：13 个文件、144 项通过。
- 静默修复回归：6 个文件、190 项通过；完整命令见下。
- `bun run build` 通过，包括 TypeScript、脚本及测试 mock 类型检查、Dashboard 打包和资产审计。
- `bun run test -- --maxWorkers=4`：24,621 通过、2 失败、133 跳过，共 1,399 个测试文件。没有把这次全量运行标为全绿。
- 失败复查：`daemon-rename-route.test.ts` 中 `/tw` 断言在未修改的 canonical checkout 同样失败（102 通过、1 失败）；`worker-argv-reaction-status.integration.test.ts` 单独重跑通过（14 项）。两文件合跑共 116 通过、1 个同样的基线失败。

企微定向检查：

```bash
bun run test -- test/wecom-config.test.ts test/wecom-message.test.ts test/wecom-store.test.ts test/wecom-bridge.test.ts test/wecom-core-client.test.ts test/wecom-transport.test.ts test/wecom-runtime.test.ts
bun run build
bun run test -- test/async-terminal-settle.test.ts test/async-trigger-store.test.ts test/bridge-final-output-retry.test.ts test/codex-app-turn-dispatch.test.ts test/codex-app-dispatch-ledger.test.ts test/worker-codex-app-turn-routing.integration.test.ts
bun run build:bun -- --out /absolute/path/botmux-wecom
```

编译版 check-config 成功，同机器人重复启动在加锁阶段被拒绝，未建立第二条真实连接。最终单文件二进制已启动企微连接、core-only 和恢复后的 worker，认证及 ready 均已观察到。

## 真实链路

经授权停止原 Python Demo，使用同一机器人已有凭证启动独立企微服务和专用 core-only 子进程。配置及状态保存在仓库外，仓库不包含真实 Bot ID、Secret、群标识或人员标识。观察到官方 SDK 认证成功及 core-only ready 后，通过企业微信桌面 UI 发送测试消息。

| 测试 | 已观察结果 |
| --- | --- |
| 群内 @ 计算 `17×19` | 入站落 SQLite；真实 Codex App CLI 执行；群内收到 `323`；平台发送回执与 outbox 均为成功 |
| 同群追问测试码 | 群内返回 `蓝鲸731`；两轮相同 sessionId、不同 triggerId |
| 单聊计算 `23×7` | 单聊收到 `161`；CLI 会话与群聊不同，回答未收到过群内测试码 |
| 群内 `/status` | 返回任务执行状态、待处理数量、结果投递状态 |
| 管理员群内 `/new` | 空闲时确认新会话，下一条任务绑定新的 CLI 会话 |
| 正常会话跨源码版与编译版重启 | 群内继续返回原测试码，保持同一 sessionId；二进制的企微入口、core-only、worker 均在运行 |
| 编译版新建会话及静默完成 | 实际执行 __codex-app-runner；空结果持久化为 completed，企微收到“任务执行完成，没有文本输出”，平台 ACK 成功 |
| 结果未知后的重启 | 旧任务暂停并报告未能确认，未自动重新执行；随后 `/new` 可恢复工作 |

首次测试还暴露了 Codex App 的既有静默完成缺陷：纯 `BOTMUX_NOTHING_TO_SEND` 最终消息被抑制后，异步结果未获得明确静默完成证据而一直 running。此问题纳入本分支修复，不能以“已收到消息”代替完整链路成功。企微默认固定指令明确确认允许成员的任务来源，仍保留外部数据和权限声明边界。

## 影响面及尚未实测的组合

企微使用独立入口、状态和 core-only 子进程，不改变飞书消息路由、BotConfig 或 owner 身份。共享层新增进程入口并在 core-only dotenv 后清除企微凭证；静默完成修复影响 Codex App 签名完成与 async result 持久化路径，需验证正常输出、已发送抑制及合并轮次不被当成静默。

本机真实链路为 macOS、Bun 1.4.2、Codex App、tmux 后端。没有据此宣称 Linux、全部 CLI、纯 PtyBackend、sandbox/adopt/restore 的所有组合均已实测。多人同群串行由两发送者协议测试覆盖；真实 UI 测试只使用已授权的一个登录用户。出站 ACK 丢失和限流使用协议测试验证，没有在线上刻意制造消息洪泛。

飞书 fleet 的 `bun run daemon:restart` 因本机无 bots 配置拒绝启动；实际部署对象是 `wecom serve` 管理的专用 core-only。完整运行方式见 [企业微信部署说明](wecom.md)。
