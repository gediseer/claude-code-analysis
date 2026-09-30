# Observer Cases

预定义案例用于稳定触发特定 Runtime 路径：

- `case-01-read-search`：只读 Tool Loop。
- `case-02-bug-fix`：失败测试、Permission、修改、重试。
- `case-03-subagent`：并行 Explore Agent、Task、Sidechain、Handback。
- `case-04-hooks`：PreToolUse / PostToolUse / Stop Hook。
- `case-05-explicit-prompt`：Prompt fidelity 案例；不注入 Observer System Prompt。

普通学习无需创建 JSON。直接使用：

```bash
node runtime-observer/run-observed-session.mjs \
  --endpoint http://127.0.0.1:33333/api/anthropic \
  --workspace E:/repo/project \
  --prompt "你的原始用户 Prompt"
```

`--prompt` 会以不附加换行的 UTF-8 stdin payload 传给子 Session，并用首个 child transcript user 与首个 API user 输入验证完全相同的 Unicode 字符串。Observer 不限制工具和权限，也不复制或沙箱化工作区；被观察 Session 使用 Claude Code 默认完整能力并在指定项目中自然执行。Endpoint 和采集参数不会编译进 Prompt。默认 endpoint 是开发 Observer `127.0.0.1:33333/api/anthropic`；每次真实 Run 必须有进程树连接 `33333` 的 TCP 证据，任何本地 `23333` 连接都会将实验标为 `ROUTING_FIDELITY_FAILED`。网络证据不可用时标为 `ROUTING_EVIDENCE_UNAVAILABLE`，不会声称成功；Prompt provenance 不足同样诚实标为 evidence unavailable。Coverage 会把未触发机制标为 NOT_TRIGGERED，而不是缺失。
