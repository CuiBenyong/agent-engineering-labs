# 实验索引

标着**可跑**的实验是自包含的包：`pnpm install --ignore-workspace && pnpm start`，且全部支持 `MOCK=1` 离线运行，不需要 API key。标着**文档型**的没有 `package.json`，它们是提示词模板、检查表与 `SKILL.md`，读了照着改即可。

「章节」一列链到讲解它的正文——代码说明*做了什么*，正文解释*为什么这么做*。

## [30 天从前端工程师到 Agent 工程师](https://course.front-end-js.top/learn/agent-30days)

27 个实验

| 天 | 实验 | 类型 | 章节 |
|---|---|---|---|
| D1 | [`agent-30days/day-01-streaming-cli`](./labs/agent-30days/day-01-streaming-cli) | 可跑 | [LLM API 基础：messages/roles、token、流式、temperature；Agent 到底是什么](https://course.front-end-js.top/learn/agent-30days/day-01) |
| D2 | [`agent-30days/day-02-hand-rolled-agent-loop`](./labs/agent-30days/day-02-hand-rolled-agent-loop) | 可跑 | [工具调用原理：JSON Schema、tool_use 循环；不用框架手写 Agent Loop](https://course.front-end-js.top/learn/agent-30days/day-02) |
| D3 | [`agent-30days/day-03-pi-sdk-agent`](./labs/agent-30days/day-03-pi-sdk-agent) | 可跑 | [Pi SDK 上手：三层架构、Agent Loop 对照（dg P01/P02/M02/M03）](https://course.front-end-js.top/learn/agent-30days/day-03) |
| D4 | [`agent-30days/day-04-multi-provider-router`](./labs/agent-30days/day-04-multi-provider-router) | 可跑 | [模型接入与系统提示词：多 provider 抽象与 fallback、覆盖默认人设（dg P03/P04/M04）](https://course.front-end-js.top/learn/agent-30days/day-04) |
| D5 | [`agent-30days/day-05-tools-and-events`](./labs/agent-30days/day-05-tools-and-events) | 可跑 | [工具系统与事件驱动：参数校验、错误回传让模型自纠错、事件订阅（dg P05/P06/M05/M07）](https://course.front-end-js.top/learn/agent-30days/day-05) |
| D6 | [`agent-30days/day-06-session-persistence`](./labs/agent-30days/day-06-session-persistence) | 可跑 | [消息、上下文工程与压缩、会话存储/恢复/分叉（dg M06/M08/M09/M10）](https://course.front-end-js.top/learn/agent-30days/day-06) |
| D7 | [`agent-30days/day-07-agent-service-docker`](./labs/agent-30days/day-07-agent-service-docker) | 可跑 | [封装成服务：Fastify + SSE + Docker（dg P07）；W1 复盘](https://course.front-end-js.top/learn/agent-30days/day-07) |
| D8 | [`agent-30days/day-08-mini-koda-skeleton`](./labs/agent-30days/day-08-mini-koda-skeleton) | 可跑 | [为什么 Gateway/Worker 分离；Postgres 表设计（sessions/runs/messages）+ Drizzle](https://course.front-end-js.top/learn/agent-30days/day-08) |
| D9 | [`agent-30days/day-09-redis-streams-bus`](./labs/agent-30days/day-09-redis-streams-bus) | 可跑 | [Redis Streams 消息总线：XADD/XREADGROUP/XACK/XAUTOCLAIM、consumer group、毒消息](https://course.front-end-js.top/learn/agent-30days/day-09) |
| D10 | [`agent-30days/day-10-sharding-lease`](./labs/agent-30days/day-10-sharding-lease) | 可跑 | [分片与租约：userId 哈希→shard、SET NX + TTL + Lua 续约、同用户顺序、handoff](https://course.front-end-js.top/learn/agent-30days/day-10) |
| D11 | [`agent-30days/day-11-run-state-machine`](./labs/agent-30days/day-11-run-state-machine) | 可跑 | [run 状态机、输出流回传、按 runId 保序、SSE 等待者、30s 打断合并](https://course.front-end-js.top/learn/agent-30days/day-11) |
| D12 | [`agent-30days/day-12-pgvector-memory`](./labs/agent-30days/day-12-pgvector-memory) | 可跑 | [长期记忆：pgvector、embedding、chunking、memory_search 工具](https://course.front-end-js.top/learn/agent-30days/day-12) |
| D13 | [`agent-30days/day-13-cron-and-billing`](./labs/agent-30days/day-13-cron-and-billing) | 可跑 | [cron 调度（中心调度→stream 投递）+ 成本计量（token→USD 台账、usage report）](https://course.front-end-js.top/learn/agent-30days/day-13) |
| D14 | [`agent-30days/day-14-compose-multi-worker`](./labs/agent-30days/day-14-compose-multi-worker) | 可跑 | [部署运维：compose 多 worker、心跳、健康检查、优雅停机、dev/prod 隔离；W2 复盘](https://course.front-end-js.top/learn/agent-30days/day-14) |
| D15 | [`agent-30days/day-15-langgraph-intro`](./labs/agent-30days/day-15-langgraph-intro) | 可跑 | [多 Agent 模式全景（Router/Supervisor、Planner-Executor、Critic、Swarm、Blackboard）与何时不该用；LangGraph 入门](https://course.front-end-js.top/learn/agent-30days/day-15) |
| D16 | [`agent-30days/day-16-supervisor-router`](./labs/agent-30days/day-16-supervisor-router) | 可跑 | [Supervisor 动态路由：structured output 路由、override、routingReason](https://course.front-end-js.top/learn/agent-30days/day-16) |
| D17 | [`agent-30days/day-17-planner-executor-critic`](./labs/agent-30days/day-17-planner-executor-critic) | 可跑 | [Planner–Executor–Critic + 共享工作区：workspace state、toolBudget、并行 fan-out、review 回路](https://course.front-end-js.top/learn/agent-30days/day-17) |
| D18 | [`agent-30days/day-18-checkpointer-summary`](./labs/agent-30days/day-18-checkpointer-summary) | 可跑 | [历史保真与摘要、多模态占位、checkpointer 持久化](https://course.front-end-js.top/learn/agent-30days/day-18) |
| D19 | [`agent-30days/day-19-cross-service-integration`](./labs/agent-30days/day-19-cross-service-integration) | 可跑 | [跨服务 Agent 集成：用户级 JWT 铸造、JWKS 验签、inject/memory/usage 三类接口、幂等 externalId](https://course.front-end-js.top/learn/agent-30days/day-19) |
| D20 | [`agent-30days/day-20-proactive-jobs`](./labs/agent-30days/day-20-proactive-jobs) | 可跑 | [定时 Job 与主动关怀：时区、quiet hours、每日上限、通知 provider 抽象](https://course.front-end-js.top/learn/agent-30days/day-20) |
| D21 | [`agent-30days/day-21-eval-and-tracing`](./labs/agent-30days/day-21-eval-and-tracing) | 可跑 | [评估与可观测：golden set、LLM-as-judge、tracing、失败率/成本面板；Pi vs LangGraph 总结；W3 复盘](https://course.front-end-js.top/learn/agent-30days/day-21) |
| D22 | [`agent-30days/day-22-agent-security`](./labs/agent-30days/day-22-agent-security) | 可跑 | [安全：prompt injection、工具最小权限、沙箱思路、密钥管理](https://course.front-end-js.top/learn/agent-30days/day-22) |
| D23 | [`agent-30days/day-23-mcp-server`](./labs/agent-30days/day-23-mcp-server) | 可跑 | [MCP 与 Skills：协议、server/client、与 function calling 区别；Claude Agent SDK 一览](https://course.front-end-js.top/learn/agent-30days/day-23) |
| D24 | [`agent-30days/day-24-rag-advanced`](./labs/agent-30days/day-24-rag-advanced) | 可跑 | [RAG 进阶：hybrid search、rerank、引用、recall 评估](https://course.front-end-js.top/learn/agent-30days/day-24) |
| D25 | [`agent-30days/day-25-streaming-frontend`](./labs/agent-30days/day-25-streaming-frontend) | 可跑 | [前端侧 Agent 体验：流式渲染、工具调用可视化、打断/重试、SSE hooks](https://course.front-end-js.top/learn/agent-30days/day-25) |
| D26 | [`agent-30days/day-26-system-design-templates`](./labs/agent-30days/day-26-system-design-templates) | 文档型 | [系统设计专题：Agent 平台 / 客服 Agent / 多租户 / 成本控制](https://course.front-end-js.top/learn/agent-30days/day-26) |
| D27 | [`agent-30days/day-27-resume-and-readme`](./labs/agent-30days/day-27-resume-and-readme) | 文档型 | [简历与项目包装：STAR、README、架构图、demo 视频、英文简历](https://course.front-end-js.top/learn/agent-30days/day-27) |

## [5 天提示词工程零基础](https://course.front-end-js.top/learn/prompt-engineering-5days)

5 个实验

| 天 | 实验 | 类型 | 章节 |
|---|---|---|---|
| D1 | [`prompt-engineering-5days/day-01-four-part-template`](./labs/prompt-engineering-5days/day-01-four-part-template) | 文档型 | [提示词是什么、不是什么：模型如何读指令；角色 / 任务 / 格式 / 约束四要素](https://course.front-end-js.top/learn/prompt-engineering-5days/day-01) |
| D2 | [`prompt-engineering-5days/day-02-before-after-rewrites`](./labs/prompt-engineering-5days/day-02-before-after-rewrites) | 文档型 | [few-shot、思维链、分步与自检；什么时候这些都不管用](https://course.front-end-js.top/learn/prompt-engineering-5days/day-02) |
| D3 | [`prompt-engineering-5days/day-03-structured-extraction`](./labs/prompt-engineering-5days/day-03-structured-extraction) | 可跑 | [结构化输出：JSON schema、模板与变量、多语言输出](https://course.front-end-js.top/learn/prompt-engineering-5days/day-03) |
| D4 | [`prompt-engineering-5days/day-04-prompt-ab-eval`](./labs/prompt-engineering-5days/day-04-prompt-ab-eval) | 可跑 | [迭代与评估：小样本测试集、A/B、版本管理、常见反模式](https://course.front-end-js.top/learn/prompt-engineering-5days/day-04) |
| D5 | [`prompt-engineering-5days/day-05-migration-checklist`](./labs/prompt-engineering-5days/day-05-migration-checklist) | 文档型 | [跨模型迁移：Claude / GPT / 国产模型的差异、system prompt 组织；进入 Claude 课与 Codex 课](https://course.front-end-js.top/learn/prompt-engineering-5days/day-05) |

## [Claude 高效使用：从对话到 Claude Code](https://course.front-end-js.top/learn/claude-mastery)

5 个实验

| 天 | 实验 | 类型 | 章节 |
|---|---|---|---|
| D1 | [`claude-mastery/day-01-prompt-templates`](./labs/claude-mastery/day-01-prompt-templates) | 文档型 | [提示词进阶与 Claude 的「性格」：system prompt、XML 标签、让模型先思考、结构化输出](https://course.front-end-js.top/learn/claude-mastery/day-01) |
| D2 | [`claude-mastery/day-02-pdf-cited-summary`](./labs/claude-mastery/day-02-pdf-cited-summary) | 可跑 | [长文档、多模态与 API 初见：大上下文怎么用、prompt caching 省钱、PDF 与图片输入、带引用回答；Messages API 最小调用](https://course.front-end-js.top/learn/claude-mastery/day-02) |
| D3 | [`claude-mastery/day-03-first-claude-md`](./labs/claude-mastery/day-03-first-claude-md) | 文档型 | [Claude Code 入门与上下文管理：安装、CLAUDE.md 写法与「删到不能再删」、权限模式、Plan Mode「先探索再计划再写」、/clear /compact /rewind、给 Claude 一个可验证的检查](https://course.front-end-js.top/learn/claude-mastery/day-03) |
| D4 | [`claude-mastery/day-04-hooks-and-skill`](./labs/claude-mastery/day-04-hooks-and-skill) | 可跑 | [扩展 Claude Code：hooks（确定性）vs CLAUDE.md（建议性）、skills、subagents、plugins、接 MCP server、CLI 工具优先](https://course.front-end-js.top/learn/claude-mastery/day-04) |
| D5 | [`claude-mastery/day-05-headless-ci`](./labs/claude-mastery/day-05-headless-ci) | 可跑 | [自动化与规模化：headless -p 进 CI、并行会话与 worktree、Writer / Reviewer 双会话、对抗式审查、常见失败模式；Agent SDK 20 行最小 agent](https://course.front-end-js.top/learn/claude-mastery/day-05) |

## [Codex 与 OpenAI Agents SDK 高效使用](https://course.front-end-js.top/learn/codex-mastery)

5 个实验

| 天 | 实验 | 类型 | 章节 |
|---|---|---|---|
| D1 | [`codex-mastery/day-01-agents-md`](./labs/codex-mastery/day-01-agents-md) | 文档型 | [Codex CLI 入门：安装、AGENTS.md、审批模式与沙箱、常用命令](https://course.front-end-js.top/learn/codex-mastery/day-01) |
| D2 | [`codex-mastery/day-02-cloud-task-checklist`](./labs/codex-mastery/day-02-cloud-task-checklist) | 文档型 | [Codex 进阶：云端任务、代码审查、MCP 接入、自定义指令、IDE 集成](https://course.front-end-js.top/learn/codex-mastery/day-02) |
| D3 | [`codex-mastery/day-03-responses-tools`](./labs/codex-mastery/day-03-responses-tools) | 可跑 | [Responses API 与内置工具：函数调用、web search / file search / computer use、结构化输出](https://course.front-end-js.top/learn/codex-mastery/day-03) |
| D4 | [`codex-mastery/day-04-handoff-guardrail`](./labs/codex-mastery/day-04-handoff-guardrail) | 可跑 | [OpenAI Agents SDK：agents、handoffs、guardrails、sessions、tracing](https://course.front-end-js.top/learn/codex-mastery/day-04) |
| D5 | [`codex-mastery/day-05-dual-tool-compare`](./labs/codex-mastery/day-05-dual-tool-compare) | 可跑 | [Claude 与 Codex 选型与协作：同一任务双工具实测对比、一个写一个审的混用工作流](https://course.front-end-js.top/learn/codex-mastery/day-05) |

## [7 天 MCP：把工具接进任何 Agent](https://course.front-end-js.top/learn/mcp-7days)

7 个实验

| 天 | 实验 | 类型 | 章节 |
|---|---|---|---|
| D1 | [`mcp-7days/day-01-annotate-json-rpc`](./labs/mcp-7days/day-01-annotate-json-rpc) | 文档型 | [为什么需要一个协议：host / client / server 三角、JSON-RPC 消息与三种原语](https://course.front-end-js.top/learn/mcp-7days/day-01) |
| D2 | [`mcp-7days/day-02-weather-fx-server`](./labs/mcp-7days/day-02-weather-fx-server) | 可跑 | [写第一个 MCP server：stdio 传输、官方 SDK、参数 schema、工具注解与 Inspector 调试](https://course.front-end-js.top/learn/mcp-7days/day-02) |
| D3 | [`mcp-7days/day-03-notes-resource-server`](./labs/mcp-7days/day-03-notes-resource-server) | 可跑 | [resources 与 prompts：URI 模板、变更通知、进度与日志、分页，以及客户端能力](https://course.front-end-js.top/learn/mcp-7days/day-03) |
| D4 | [`mcp-7days/day-04-streamable-http-deploy`](./labs/mcp-7days/day-04-streamable-http-deploy) | 可跑 | [远程 MCP：Streamable HTTP 绑定、无状态模型与请求元数据、OAuth 2.1 授权、容器部署](https://course.front-end-js.top/learn/mcp-7days/day-04) |
| D5 | [`mcp-7days/day-05-agent-mcp-client`](./labs/mcp-7days/day-05-agent-mcp-client) | 可跑 | [写一个 MCP client：在自己的 Agent 循环里发现并调用工具、多 server 聚合与命名冲突](https://course.front-end-js.top/learn/mcp-7days/day-05) |
| D6 | [`mcp-7days/day-06-server-security-checklist`](./labs/mcp-7days/day-06-server-security-checklist) | 文档型 | [安全与治理：工具描述里的提示注入、混淆代理、最小权限、审计日志与工具白名单](https://course.front-end-js.top/learn/mcp-7days/day-06) |
| D7 | [`mcp-7days/day-07-publishable-server-template`](./labs/mcp-7days/day-07-publishable-server-template) | 可跑 | [生产化与复盘：给工具写评估、版本化、发布到 npm 与 registry、可观测与综合项目](https://course.front-end-js.top/learn/mcp-7days/day-07) |

## [7 天 Agent Skills：把经验做成可复用能力](https://course.front-end-js.top/learn/agent-skills-7days)

7 个实验

| 天 | 实验 | 类型 | 章节 |
|---|---|---|---|
| D1 | [`agent-skills-7days/day-01-skill-anatomy`](./labs/agent-skills-7days/day-01-skill-anatomy) | 文档型 | [Skills 是什么：SKILL.md 规范、目录结构与三阶段渐进式加载](https://course.front-end-js.top/learn/agent-skills-7days/day-01) |
| D2 | [`agent-skills-7days/day-02-commit-message-skill`](./labs/agent-skills-7days/day-02-commit-message-skill) | 文档型 | [写第一个 skill：description 的触发词怎么写、结构怎么分层、怎么装进客户端](https://course.front-end-js.top/learn/agent-skills-7days/day-02) |
| D3 | [`agent-skills-7days/day-03-trigger-eval`](./labs/agent-skills-7days/day-03-trigger-eval) | 可跑 | [设计方法：从重复任务提炼、检查清单式与参考手册式、四种反模式与触发测试](https://course.front-end-js.top/learn/agent-skills-7days/day-03) |
| D4 | [`agent-skills-7days/day-04-doc-skill-with-scripts`](./labs/agent-skills-7days/day-04-doc-skill-with-scripts) | 可跑 | [带脚本的 skill：可执行附件、依赖与沙箱、跨平台，以及文档处理类 skill 的拆解](https://course.front-end-js.top/learn/agent-skills-7days/day-04) |
| D5 | [`agent-skills-7days/day-05-skill-runtime`](./labs/agent-skills-7days/day-05-skill-runtime) | 可跑 | [手写一个 skill 运行时：扫描、frontmatter 解析、注入系统提示、按需读取正文](https://course.front-end-js.top/learn/agent-skills-7days/day-05) |
| D6 | [`agent-skills-7days/day-06-skill-plugin-pack`](./labs/agent-skills-7days/day-06-skill-plugin-pack) | 文档型 | [组织与分发：插件与市场、版本与团队共享，以及函数调用、MCP、Skills 三者的分工](https://course.front-end-js.top/learn/agent-skills-7days/day-06) |
| D7 | [`agent-skills-7days/day-07-team-skill-pack`](./labs/agent-skills-7days/day-07-team-skill-pack) | 文档型 | [综合与复盘：把一套团队规范做成 skill 包并驱动子代理完成一次真实任务](https://course.front-end-js.top/learn/agent-skills-7days/day-07) |

## [5 天上下文工程](https://course.front-end-js.top/learn/context-engineering-5days)

5 个实验

| 天 | 实验 | 类型 | 章节 |
|---|---|---|---|
| D1 | [`context-engineering-5days/day-01-context-profile`](./labs/context-engineering-5days/day-01-context-profile) | 可跑 | [上下文是最稀缺的资源：窗口、注意力衰减与成本，从提示词工程走到上下文工程](https://course.front-end-js.top/learn/context-engineering-5days/day-01) |
| D2 | [`context-engineering-5days/day-02-instruction-file`](./labs/context-engineering-5days/day-02-instruction-file) | 文档型 | [系统提示与指令层次：高度适中、持久指令文件、渐进披露，少即是多](https://course.front-end-js.top/learn/context-engineering-5days/day-02) |
| D3 | [`context-engineering-5days/day-03-tool-result-trimmer`](./labs/context-engineering-5days/day-03-tool-result-trimmer) | 可跑 | [工具结果与检索的上下文管理：按需加载、摘要与裁剪、结构化返回](https://course.front-end-js.top/learn/context-engineering-5days/day-03) |
| D4 | [`context-engineering-5days/day-04-compaction-strategy`](./labs/context-engineering-5days/day-04-compaction-strategy) | 可跑 | [长时程会话：压缩、笔记与记忆文件、子代理隔离与交接摘要](https://course.front-end-js.top/learn/context-engineering-5days/day-04) |
| D5 | [`context-engineering-5days/day-05-tuning-report`](./labs/context-engineering-5days/day-05-tuning-report) | 文档型 | [度量与调优：token 账单、上下文利用率、失败模式排查与综合面试专题](https://course.front-end-js.top/learn/context-engineering-5days/day-05) |

## [7 天前端 Agent 体验：从流式到生成式界面](https://course.front-end-js.top/learn/frontend-agent-ux-7days)

7 个实验

| 天 | 实验 | 类型 | 章节 |
|---|---|---|---|
| D1 | [`frontend-agent-ux-7days/day-01-first-stream`](./labs/frontend-agent-ux-7days/day-01-first-stream) | 可跑 | [Agent 前端难在哪：事件协议与浏览器里的第一条流](https://course.front-end-js.top/learn/frontend-agent-ux-7days/day-01) |
| D2 | [`frontend-agent-ux-7days/day-02-steady-stream`](./labs/frontend-agent-ux-7days/day-02-steady-stream) | 可跑 | [不抖的流式渲染：渲染风暴、增量 Markdown 与滚动锚定](https://course.front-end-js.top/learn/frontend-agent-ux-7days/day-02) |
| D3 | [`frontend-agent-ux-7days/day-03-tool-approval`](./labs/frontend-agent-ux-7days/day-03-tool-approval) | 可跑 | [工具调用可视化与人在回路：中断不是本地拦截](https://course.front-end-js.top/learn/frontend-agent-ux-7days/day-03) |
| D4 | [`frontend-agent-ux-7days/day-04-reasoning-state`](./labs/frontend-agent-ux-7days/day-04-reasoning-state) | 可跑 | [推理过程与共享状态：可折叠的思考区和增量同步](https://course.front-end-js.top/learn/frontend-agent-ux-7days/day-04) |
| D5 | [`frontend-agent-ux-7days/day-05-generative-ui`](./labs/frontend-agent-ux-7days/day-05-generative-ui) | 可跑 | [生成式界面的三种范式：从组件映射到声明式 UI](https://course.front-end-js.top/learn/frontend-agent-ux-7days/day-05) |
| D6 | [`frontend-agent-ux-7days/day-06-workbench`](./labs/frontend-agent-ux-7days/day-06-workbench) | 可跑 | [会话控制与长任务：打断、重试、分支与子 Agent](https://course.front-end-js.top/learn/frontend-agent-ux-7days/day-06) |
| D7 | [`frontend-agent-ux-7days/day-07-accessible-workbench`](./labs/frontend-agent-ux-7days/day-07-accessible-workbench) | 可跑 | [可访问性与性能预算：让流式界面对所有人可用](https://course.front-end-js.top/learn/frontend-agent-ux-7days/day-07) |

## [14 天 RAG：从检索到可信回答](https://course.front-end-js.top/learn/rag-14days)

14 个实验

| 天 | 实验 | 类型 | 章节 |
|---|---|---|---|
| D1 | [`rag-14days/day-01-bm25-mini-rag`](./labs/rag-14days/day-01-bm25-mini-rag) | 可跑 | [为什么要检索：幻觉、知识截止与长上下文的代价，以及一个纯关键词的最小 RAG](https://course.front-end-js.top/learn/rag-14days/day-01) |
| D2 | [`rag-14days/day-02-pgvector-nearest-neighbor`](./labs/rag-14days/day-02-pgvector-nearest-neighbor) | 可跑 | [embedding 与向量检索：相似度、维度与模型选型，把文本存进 pgvector](https://course.front-end-js.top/learn/rag-14days/day-02) |
| D3 | [`rag-14days/day-03-document-parsing-pipeline`](./labs/rag-14days/day-03-document-parsing-pipeline) | 可跑 | [文档进来这一关：PDF 与 HTML 解析、表格与扫描件、清洗规则和必须留下的元数据](https://course.front-end-js.top/learn/rag-14days/day-03) |
| D4 | [`rag-14days/day-04-chunking-strategies`](./labs/rag-14days/day-04-chunking-strategies) | 可跑 | [切块策略：固定、递归、按结构、父子与语义五种切法，以及用评估而不是直觉来选](https://course.front-end-js.top/learn/rag-14days/day-04) |
| D5 | [`rag-14days/day-05-index-tuning-and-filters`](./labs/rag-14days/day-05-index-tuning-and-filters) | 可跑 | [向量索引与库选型：HNSW 与倒排文件、量化省内存、带过滤的查询与多租户隔离](https://course.front-end-js.top/learn/rag-14days/day-05) |
| D6 | [`rag-14days/day-06-cited-answer-api`](./labs/rag-14days/day-06-cited-answer-api) | 可跑 | [生成这一侧：上下文怎么排、引用怎么标、什么时候必须拒答，以及流式回答](https://course.front-end-js.top/learn/rag-14days/day-06) |
| D7 | [`rag-14days/day-07-rag-service`](./labs/rag-14days/day-07-rag-service) | 可跑 | [第一周综合：把六天的零件装成一个可一键启动的检索问答服务并复盘](https://course.front-end-js.top/learn/rag-14days/day-07) |
| D8 | [`rag-14days/day-08-eval-harness`](./labs/rag-14days/day-08-eval-harness) | 可跑 | [评估先行：搭 golden set、算召回与排序指标、用模型当裁判判忠实度](https://course.front-end-js.top/learn/rag-14days/day-08) |
| D9 | [`rag-14days/day-09-hybrid-and-rerank`](./labs/rag-14days/day-09-hybrid-and-rerank) | 可跑 | [混合检索与重排：两路召回、倒数排名融合，再用交叉编码器把前几名重新排一遍](https://course.front-end-js.top/learn/rag-14days/day-09) |
| D10 | [`rag-14days/day-10-query-transformations`](./labs/rag-14days/day-10-query-transformations) | 可跑 | [查询侧优化：改写、假设文档嵌入、多路查询、后退提问与意图路由](https://course.front-end-js.top/learn/rag-14days/day-10) |
| D11 | [`rag-14days/day-11-parent-child-and-contextual`](./labs/rag-14days/day-11-parent-child-and-contextual) | 可跑 | [高级索引：父子文档、摘要索引、上下文检索，以及树状聚合与图检索的取舍](https://course.front-end-js.top/learn/rag-14days/day-11) |
| D12 | [`rag-14days/day-12-agentic-retrieval`](./labs/rag-14days/day-12-agentic-retrieval) | 可跑 | [Agentic RAG：把检索做成工具，让模型自己决定查不查、查几次、要不要推翻重来](https://course.front-end-js.top/learn/rag-14days/day-12) |
| D13 | [`rag-14days/day-13-incremental-and-acl`](./labs/rag-14days/day-13-incremental-and-acl) | 可跑 | [上生产：增量同步与去重、按权限过滤、缓存分层、链路追踪与成本延迟账](https://course.front-end-js.top/learn/rag-14days/day-13) |
| D14 | [`rag-14days/day-14-capstone-knowledge-base`](./labs/rag-14days/day-14-capstone-knowledge-base) | 可跑 | [综合项目与复盘：多租户企业知识库问答，一张 RAG 决策地图与面试专题](https://course.front-end-js.top/learn/rag-14days/day-14) |

## [14 天用 Agent 搭一条 AI 短剧生产线](https://course.front-end-js.top/learn/ai-drama-pipeline)

14 个实验

| 天 | 实验 | 类型 | 章节 |
|---|---|---|---|
| D1 | [`ai-drama-pipeline/day-01-pipeline-skeleton`](./labs/ai-drama-pipeline/day-01-pipeline-skeleton) | 可跑 | [一条 AI 短剧生产线长什么样：工序拆解、任务图架构与四类生成模型选型](https://course.front-end-js.top/learn/ai-drama-pipeline/day-01) |
| D2 | [`ai-drama-pipeline/day-02-script-agent`](./labs/ai-drama-pipeline/day-02-script-agent) | 可跑 | [剧本 Agent：把一句话变成人物卡、场景与分镜的结构化数据](https://course.front-end-js.top/learn/ai-drama-pipeline/day-02) |
| D3 | [`ai-drama-pipeline/day-03-character-assets`](./labs/ai-drama-pipeline/day-03-character-assets) | 可跑 | [角色一致性：定妆图、参考图与风格锁定，让同一个人每一镜都还是他](https://course.front-end-js.top/learn/ai-drama-pipeline/day-03) |
| D4 | [`ai-drama-pipeline/day-04-shot-video`](./labs/ai-drama-pipeline/day-04-shot-video) | 可跑 | [从分镜到镜头：图生视频、异步任务轮询与失败重试](https://course.front-end-js.top/learn/ai-drama-pipeline/day-04) |
| D5 | [`ai-drama-pipeline/day-05-voice-subtitle`](./labs/ai-drama-pipeline/day-05-voice-subtitle) | 可跑 | [配音、字幕与音轨：多角色语音、时间轴对齐与字幕文件](https://course.front-end-js.top/learn/ai-drama-pipeline/day-05) |
| D6 | [`ai-drama-pipeline/day-06-ffmpeg-compose`](./labs/ai-drama-pipeline/day-06-ffmpeg-compose) | 可跑 | [剪辑台：用 ffmpeg 把素材合成一集竖屏成片](https://course.front-end-js.top/learn/ai-drama-pipeline/day-06) |
| D7 | [`ai-drama-pipeline/day-07-end-to-end`](./labs/ai-drama-pipeline/day-07-end-to-end) | 可跑 | [一集杀青：把六个环节串成端到端流水线并算清第一笔账](https://course.front-end-js.top/learn/ai-drama-pipeline/day-07) |
| D8 | [`ai-drama-pipeline/day-08-workflow-engine`](./labs/ai-drama-pipeline/day-08-workflow-engine) | 可跑 | [工作流引擎：把流水线做成可断点续跑的任务图](https://course.front-end-js.top/learn/ai-drama-pipeline/day-08) |
| D9 | [`ai-drama-pipeline/day-09-parallel-episodes`](./labs/ai-drama-pipeline/day-09-parallel-episodes) | 可跑 | [并发与配额：多集同时开机，还不能把厂商额度打爆](https://course.front-end-js.top/learn/ai-drama-pipeline/day-09) |
| D10 | [`ai-drama-pipeline/day-10-review-console`](./labs/ai-drama-pipeline/day-10-review-console) | 可跑 | [审片室：能预览、能改词、能重生成单镜的人机协作后台](https://course.front-end-js.top/learn/ai-drama-pipeline/day-10) |
| D11 | [`ai-drama-pipeline/day-11-qc-compliance`](./labs/ai-drama-pipeline/day-11-qc-compliance) | 可跑 | [质检与合规：机器审片、内容安全、生成内容标识与版权边界](https://course.front-end-js.top/learn/ai-drama-pipeline/day-11) |
| D12 | [`ai-drama-pipeline/day-12-cost-router`](./labs/ai-drama-pipeline/day-12-cost-router) | 可跑 | [成本与模型路由：按环节选模型、缓存、降级与预算熔断](https://course.front-end-js.top/learn/ai-drama-pipeline/day-12) |
| D13 | [`ai-drama-pipeline/day-13-multi-platform-export`](./labs/ai-drama-pipeline/day-13-multi-platform-export) | 可跑 | [发行：多平台规格适配、封面与标题生成、批量导出与数据回收](https://course.front-end-js.top/learn/ai-drama-pipeline/day-13) |
| D14 | [`ai-drama-pipeline/day-14-season-portfolio`](./labs/ai-drama-pipeline/day-14-season-portfolio) | 可跑 | [一季五集：批量产出、作品集包装与短剧生产线面试专题](https://course.front-end-js.top/learn/ai-drama-pipeline/day-14) |

## [21 天手搓一个 Coding Agent](https://course.front-end-js.top/learn/my-coding-agent-21days)

21 个实验

| 天 | 实验 | 类型 | 章节 |
|---|---|---|---|
| D1 | [`my-coding-agent-21days/day-01-repl-skeleton`](./labs/my-coding-agent-21days/day-01-repl-skeleton) | 可跑 | [一个 Coding Agent 由哪几层组成：REPL 骨架、命令系统与不绑厂商的网关抽象](https://course.front-end-js.top/learn/my-coding-agent-21days/day-01) |
| D2 | [`my-coding-agent-21days/day-02-streaming-render`](./labs/my-coding-agent-21days/day-02-streaming-render) | 可跑 | [流式输出与终端渲染：手写 SSE 解析、增量 Markdown 与可打断的打字机](https://course.front-end-js.top/learn/my-coding-agent-21days/day-02) |
| D3 | [`my-coding-agent-21days/day-03-readonly-tools`](./labs/my-coding-agent-21days/day-03-readonly-tools) | 可跑 | [工具协议与只读三件套：schema 设计、分片归并与结果截断](https://course.front-end-js.top/learn/my-coding-agent-21days/day-03) |
| D4 | [`my-coding-agent-21days/day-04-edit-and-shell`](./labs/my-coding-agent-21days/day-04-edit-and-shell) | 可跑 | [文件编辑与 shell 执行：精确替换、冲突检测与超时可杀的子进程](https://course.front-end-js.top/learn/my-coding-agent-21days/day-04) |
| D5 | [`my-coding-agent-21days/day-05-approval-gate`](./labs/my-coding-agent-21days/day-05-approval-gate) | 可跑 | [权限与审批：三态规则、按工具与路径匹配，以及自动模式的边界](https://course.front-end-js.top/learn/my-coding-agent-21days/day-05) |
| D6 | [`my-coding-agent-21days/day-06-error-recovery`](./labs/my-coding-agent-21days/day-06-error-recovery) | 可跑 | [错误处理与自纠：失败回灌、退避重试、死循环检测与取消中断](https://course.front-end-js.top/learn/my-coding-agent-21days/day-06) |
| D7 | [`my-coding-agent-21days/day-07-session-resume`](./labs/my-coding-agent-21days/day-07-session-resume) | 可跑 | [会话持久化与恢复：只追加的事件日志、resume 与分叉，第一周复盘](https://course.front-end-js.top/learn/my-coding-agent-21days/day-07) |
| D8 | [`my-coding-agent-21days/day-08-at-references`](./labs/my-coding-agent-21days/day-08-at-references) | 可跑 | [引用注入：解析 @ 文件、目录、URL 与图片，并把注入量说清楚](https://course.front-end-js.top/learn/my-coding-agent-21days/day-08) |
| D9 | [`my-coding-agent-21days/day-09-project-instructions`](./labs/my-coding-agent-21days/day-09-project-instructions) | 可跑 | [项目指令文件：三层加载、导入展开与 system prompt 的合并顺序](https://course.front-end-js.top/learn/my-coding-agent-21days/day-09) |
| D10 | [`my-coding-agent-21days/day-10-todo-tracking`](./labs/my-coding-agent-21days/day-10-todo-tracking) | 可跑 | [任务清单与自我规划：todo 工具、进度渲染与打转的早期发现](https://course.front-end-js.top/learn/my-coding-agent-21days/day-10) |
| D11 | [`my-coding-agent-21days/day-11-memory`](./labs/my-coding-agent-21days/day-11-memory) | 可跑 | [跨会话记忆：显式记忆、自动记忆与检索注入的三个判据](https://course.front-end-js.top/learn/my-coding-agent-21days/day-11) |
| D12 | [`my-coding-agent-21days/day-12-context-compaction`](./labs/my-coding-agent-21days/day-12-context-compaction) | 可跑 | [上下文压缩：token 怎么数、压什么留什么、压完怎么验证没丢](https://course.front-end-js.top/learn/my-coding-agent-21days/day-12) |
| D13 | [`my-coding-agent-21days/day-13-plan-mode`](./labs/my-coding-agent-21days/day-13-plan-mode) | 可跑 | [先问后做：结构化提问工具、只读探索模式与计划审批](https://course.front-end-js.top/learn/my-coding-agent-21days/day-13) |
| D14 | [`my-coding-agent-21days/day-14-checkpoint-rewind`](./labs/my-coding-agent-21days/day-14-checkpoint-rewind) | 可跑 | [checkpoint 与 rewind：文件快照、对话回退，以及两者为什么必须独立](https://course.front-end-js.top/learn/my-coding-agent-21days/day-14) |
| D15 | [`my-coding-agent-21days/day-15-mcp-client`](./labs/my-coding-agent-21days/day-15-mcp-client) | 可跑 | [接入 MCP：手写 JSON-RPC 客户端、两种传输与工具命名空间](https://course.front-end-js.top/learn/my-coding-agent-21days/day-15) |
| D16 | [`my-coding-agent-21days/day-16-skill-loader`](./labs/my-coding-agent-21days/day-16-skill-loader) | 可跑 | [加载 Skills：扫描、渐进披露与触发判定，让经验按需上桌](https://course.front-end-js.top/learn/my-coding-agent-21days/day-16) |
| D17 | [`my-coding-agent-21days/day-17-subagents`](./labs/my-coding-agent-21days/day-17-subagents) | 可跑 | [子 Agent 与并行：独立上下文、工具白名单、worktree 隔离与结果汇总](https://course.front-end-js.top/learn/my-coding-agent-21days/day-17) |
| D18 | [`my-coding-agent-21days/day-18-hooks`](./labs/my-coding-agent-21days/day-18-hooks) | 可跑 | [hooks 与后台任务：生命周期钩子、确定性检查与不打断对话的通知](https://course.front-end-js.top/learn/my-coding-agent-21days/day-18) |
| D19 | [`my-coding-agent-21days/day-19-multimodal`](./labs/my-coding-agent-21days/day-19-multimodal) | 可跑 | [多模态输入：粘贴截图、图片校验与照图改代码](https://course.front-end-js.top/learn/my-coding-agent-21days/day-19) |
| D20 | [`my-coding-agent-21days/day-20-evals-and-cost`](./labs/my-coding-agent-21days/day-20-evals-and-cost) | 可跑 | [评估与成本：基准集怎么设计、通过率怎么算、token 与缓存命中怎么看](https://course.front-end-js.top/learn/my-coding-agent-21days/day-20) |
| D21 | [`my-coding-agent-21days/day-21-ship-it`](./labs/my-coding-agent-21days/day-21-ship-it) | 可跑 | [打包与发布：全局命令、配置目录、版本与更新，二十一天总复盘](https://course.front-end-js.top/learn/my-coding-agent-21days/day-21) |

## [7 天 Agent 评估与可观测：让「感觉还行」变成可复现的数字](https://course.front-end-js.top/learn/agent-evals-7days)

7 个实验

| 天 | 实验 | 类型 | 章节 |
|---|---|---|---|
| D1 | [`agent-evals-7days/day-01-first-eval`](./labs/agent-evals-7days/day-01-first-eval) | 可跑 | [为什么 Agent 不能靠「试几次感觉还行」](https://course.front-end-js.top/learn/agent-evals-7days/day-01) |
| D2 | [`agent-evals-7days/day-02-golden-set`](./labs/agent-evals-7days/day-02-golden-set) | 可跑 | [基准集：把线上翻过的车变成可复现的任务](https://course.front-end-js.top/learn/agent-evals-7days/day-02) |
| D3 | [`agent-evals-7days/day-03-llm-judge`](./labs/agent-evals-7days/day-03-llm-judge) | 可跑 | [让模型当裁判，再把裁判本身考一遍](https://course.front-end-js.top/learn/agent-evals-7days/day-03) |
| D4 | [`agent-evals-7days/day-04-trajectory`](./labs/agent-evals-7days/day-04-trajectory) | 可跑 | [轨迹评估：它到了终点，但一路上撞了几次](https://course.front-end-js.top/learn/agent-evals-7days/day-04) |
| D5 | [`agent-evals-7days/day-05-tracing`](./labs/agent-evals-7days/day-05-tracing) | 可跑 | [可观测：给每一次运行装上行车记录仪](https://course.front-end-js.top/learn/agent-evals-7days/day-05) |
| D6 | [`agent-evals-7days/day-06-ci-gate`](./labs/agent-evals-7days/day-06-ci-gate) | 可跑 | [回归门禁：让退化在合并之前就被拦住](https://course.front-end-js.top/learn/agent-evals-7days/day-06) |
| D7 | [`agent-evals-7days/day-07-suite-health`](./labs/agent-evals-7days/day-07-suite-health) | 可跑 | [体检套件本身：饱和、坏任务与判分缺陷](https://course.front-end-js.top/learn/agent-evals-7days/day-07) |

## [5 天 Agent 安全](https://course.front-end-js.top/learn/agent-security-5days)

5 个实验

| 天 | 实验 | 类型 | 章节 |
|---|---|---|---|
| D1 | [`agent-security-5days/day-01-threat-model`](./labs/agent-security-5days/day-01-threat-model) | 可跑 | [威胁模型：致命三件套、信任边界，以及两张 OWASP 清单怎么当检查表用](https://course.front-end-js.top/learn/agent-security-5days/day-01) |
| D2 | [`agent-security-5days/day-02-injection-range`](./labs/agent-security-5days/day-02-injection-range) | 可跑 | [注入靶场与输入侧防御：四档防御各自挡住了什么，又各自在哪里失手](https://course.front-end-js.top/learn/agent-security-5days/day-02) |
| D3 | [`agent-security-5days/day-03-secure-patterns`](./labs/agent-security-5days/day-03-secure-patterns) | 可跑 | [架构级防御：六个设计模式，以及先定计划后执行怎么把攻击成功率压到零](https://course.front-end-js.top/learn/agent-security-5days/day-03) |
| D4 | [`agent-security-5days/day-04-sandboxed-executor`](./labs/agent-security-5days/day-04-sandboxed-executor) | 可跑 | [运行时管控：能力面、确认门、出口白名单、沙箱分层，以及密钥与租户隔离](https://course.front-end-js.top/learn/agent-security-5days/day-04) |
| D5 | [`agent-security-5days/day-05-red-team-loop`](./labs/agent-security-5days/day-05-red-team-loop) | 可跑 | [红队与演练：攻击用例集怎么长期维护、怎么进 CI，以及出事之后怎么办](https://course.front-end-js.top/learn/agent-security-5days/day-05) |

---

13 门课合计 **129 个实验**——112 个可跑，17 个文档型。本文件由课程仓库的 `scripts/build-labs-index.mjs` 生成，要改请改那里。
