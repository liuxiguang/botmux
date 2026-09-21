# 员工通道实施计划

1. 配置与 CLI 边界：先加入员工模式配置/身份/参数安全失败测试；实现 employee-config 与 employee-client，保持现有 bot 配置兼容。
2. 增量收件：测试启动水位、重启去重、分页、自己消息、会话授权和失败不推进水位；实现 employee-inbox，复用 SQLite 元数据及 bridge。
3. 回调：用真实本地 HTTP 与独立加密 fixture 测试 GET 验证、POST 唤醒、坏签名、企业不匹配和重放；实现 callback。
4. 生命周期：接入 runtime，处理锁、CLI 队列限速、补拉、停止和身份变更。出站文本分段必须满足 CLI 限制。
5. 验证交付：企微及共享路径回归、bun run build；私有配置部署独立员工实例，通过测试群实测员工发送→Codex→员工回复。记录真实 callback 是否已具备凭证，不虚构平台回调成功。
