# Observation Coverage Roadmap

Observer 当前的 68 个源码级观察点覆盖原生 VS Code Session 与历史 Headless Agent 路径，但不同机制需要专门 Case 才能触发。

## 已实现的捕获方式

```text
Visible native VS Code process
├─ official Claude Code Webview / user-controlled permission UI
├─ exact URI prompt prefill（用户按 Enter 提交）
├─ claude-vscode transcript / subagent / tool-results / file-history / plan
├─ native extension Session state / Output log
├─ exact Session ID correlation
├─ process-tree TCP evidence: required 33333, forbidden 23333
└─ Agent Maestro Observer capture
   ├─ complete Request entity body / headers redacted
   ├─ Messages / Tool Schemas / request parameters
   ├─ first transcript user ↔ first API user provenance
   ├─ request / response metadata + SHA-256
   └─ raw SSE response bytes

Legacy headless profile remains replayable but is explicitly NONPARITY.
```

## 已实现的自动解释

- Capture Coverage：68 点、15 层、7 个生命周期不变量（含 prompt provenance 验证）。
- Prompt Turns：每轮可观察 Messages、Tools 和参数。
- API Turns：Request/Response、Context 增量、SSE、Usage。
- Tool Lifecycles：Validation、Hook、Permission、Dispatch、Execution、Result。
- Teaching Replay：中文逐步回放和源码链接。
- Run Comparator：不同任务在 turns、tools、agents、cost 和层级覆盖上的差异。

## 需要用户 Case 或专项 Fixture 才能触发

| 专项机制 | 推荐 Case |
|---|---|
| Retry / Fallback | Fake/可控上游先返回 529/500，再成功 |
| Compact | 小 context limit 或构造长会话，触发 auto/manual compact |
| Session Memory / Auto Memory | 多轮事实积累并等待提取阈值 |
| Resume / Fork | 中断 Session，再用 `--resume` / `--fork-session` |
| Background Agent / TaskStop | 启动长运行 Agent，转后台、查询、停止 |
| MCP | 本地可控 MCP server，记录 transport/tool/resource |
| Permission Ask UI | Native VS Code Case，由用户在可见原生权限卡片中决定 |
| Sandbox | 启用 sandbox 的 Bash/网络/文件允许与拒绝案例 |
| Large Tool Result | 产生超过阈值结果，验证 tool-results 文件与 preview |
| Worktree | `--worktree` 或 Agent isolation worktree |
| Remote/CCR | 单独 Remote Control/Bridge Case |

## 尚未实现的捕获器

### Native Webview 像素帧

原生权限 UI 已由独立可见 VS Code 窗口提供，并通过 Extension Session state、用户响应和后续 Tool Result 保留语义证据。Observer 不注入 Webview 脚本或自动点击，因为那会改变正常执行路径。若未来需要像素级帧，应使用 VS Code 外部屏幕录制，并明确标为独立观察通道。

### 非模型网络/MCP Wire Proxy

Recording Proxy 只捕获 Claude 模型 API；MCP/业务网络可能使用不同 transport 与进程。需要按 MCP stdio/SSE/HTTP/WebSocket 分别提供可控 server/relay，不能把模型 API Proxy 误称为全部网络观察。

## 完整度原则

以后只有满足下列条件才称某观察点 CAPTURED：

1. Observation Registry 中存在该点；
2. Case 触发条件成立；
3. 所有登记 Evidence 存在；
4. 对应生命周期 Invariant 通过；
5. Raw 文件与教学视图可互相链接。

否则必须显示 PARTIAL、MISSING、NOT_TRIGGERED 或 NOT_EXPOSED。
