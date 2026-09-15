# Lab Index

Labs marked **runnable** are self-contained packages: `pnpm install --ignore-workspace && pnpm start`, and every one of them runs offline with `MOCK=1` — no API key needed. Labs marked **doc** have no `package.json`; they are prompt templates, checklists and `SKILL.md` files you read and adapt.

The "Chapter" column links to the walkthrough that explains the lab — the code shows *what*, the chapter explains *why*.

## [From Frontend Engineer to Agent Engineer in 30 Days](https://course.front-end-js.top/en/learn/agent-30days)

27 labs

| Day | Lab | Type | Chapter |
|---|---|---|---|
| D1 | [`agent-30days/day-01-streaming-cli`](./labs/agent-30days/day-01-streaming-cli) | runnable | [LLM API Basics: messages/roles, Tokens, Streaming, Temperature; What an Agent Actually Is](https://course.front-end-js.top/en/learn/agent-30days/day-01) |
| D2 | [`agent-30days/day-02-hand-rolled-agent-loop`](./labs/agent-30days/day-02-hand-rolled-agent-loop) | runnable | [How Tool Calling Works: JSON Schema, the tool_use Loop; Hand-Writing an Agent Loop With No Framework](https://course.front-end-js.top/en/learn/agent-30days/day-02) |
| D3 | [`agent-30days/day-03-pi-sdk-agent`](./labs/agent-30days/day-03-pi-sdk-agent) | runnable | [Getting Started With the Pi SDK: the Three-Layer Architecture, Comparing It to the Agent Loop (dg P01/P02/M02/M03)](https://course.front-end-js.top/en/learn/agent-30days/day-03) |
| D4 | [`agent-30days/day-04-multi-provider-router`](./labs/agent-30days/day-04-multi-provider-router) | runnable | [Model Integration and System Prompts: a Multi-Provider Abstraction With Fallback, Overriding the Default Persona (dg P03/P04/M04)](https://course.front-end-js.top/en/learn/agent-30days/day-04) |
| D5 | [`agent-30days/day-05-tools-and-events`](./labs/agent-30days/day-05-tools-and-events) | runnable | [The Tool System and Event-Driven Design: Parameter Validation, Feeding Errors Back for Self-Correction, Event Subscription (dg P05/P06/M05/M07)](https://course.front-end-js.top/en/learn/agent-30days/day-05) |
| D6 | [`agent-30days/day-06-session-persistence`](./labs/agent-30days/day-06-session-persistence) | runnable | [Messages, Context Engineering and Compression, Session Storage/Recovery/Forking (dg M06/M08/M09/M10)](https://course.front-end-js.top/en/learn/agent-30days/day-06) |
| D7 | [`agent-30days/day-07-agent-service-docker`](./labs/agent-30days/day-07-agent-service-docker) | runnable | [Packaging It as a Service: Fastify + SSE + Docker (dg P07); Week One Retrospective](https://course.front-end-js.top/en/learn/agent-30days/day-07) |
| D8 | [`agent-30days/day-08-mini-koda-skeleton`](./labs/agent-30days/day-08-mini-koda-skeleton) | runnable | [Why Split Gateway and Worker; Postgres Table Design (sessions/runs/messages) + Drizzle](https://course.front-end-js.top/en/learn/agent-30days/day-08) |
| D9 | [`agent-30days/day-09-redis-streams-bus`](./labs/agent-30days/day-09-redis-streams-bus) | runnable | [A Redis Streams Message Bus: XADD/XREADGROUP/XACK/XAUTOCLAIM, Consumer Groups, Poison Messages](https://course.front-end-js.top/en/learn/agent-30days/day-09) |
| D10 | [`agent-30days/day-10-sharding-lease`](./labs/agent-30days/day-10-sharding-lease) | runnable | [Sharding and Leases: Hashing userId → shard, SET NX + TTL + Lua Renewal, Per-User Ordering, Handoff](https://course.front-end-js.top/en/learn/agent-30days/day-10) |
| D11 | [`agent-30days/day-11-run-state-machine`](./labs/agent-30days/day-11-run-state-machine) | runnable | [The Run State Machine, Streaming Output Back, Ordering by runId, SSE Waiters, Merging Interruptions Within 30 Seconds](https://course.front-end-js.top/en/learn/agent-30days/day-11) |
| D12 | [`agent-30days/day-12-pgvector-memory`](./labs/agent-30days/day-12-pgvector-memory) | runnable | [Long-Term Memory: pgvector, Embeddings, Chunking, the memory_search Tool](https://course.front-end-js.top/en/learn/agent-30days/day-12) |
| D13 | [`agent-30days/day-13-cron-and-billing`](./labs/agent-30days/day-13-cron-and-billing) | runnable | [Cron Scheduling (Central Scheduler → Stream Delivery) + Cost Metering (Token → USD Ledger, Usage Report)](https://course.front-end-js.top/en/learn/agent-30days/day-13) |
| D14 | [`agent-30days/day-14-compose-multi-worker`](./labs/agent-30days/day-14-compose-multi-worker) | runnable | [Deployment and Operations: Multi-Worker Compose, Heartbeats, Health Checks, Graceful Shutdown, Dev/Prod Isolation; Week Two Retrospective](https://course.front-end-js.top/en/learn/agent-30days/day-14) |
| D15 | [`agent-30days/day-15-langgraph-intro`](./labs/agent-30days/day-15-langgraph-intro) | runnable | [A Tour of Multi-Agent Patterns (Router/Supervisor, Planner-Executor, Critic, Swarm, Blackboard) and When Not to Use Them; Getting Started With LangGraph](https://course.front-end-js.top/en/learn/agent-30days/day-15) |
| D16 | [`agent-30days/day-16-supervisor-router`](./labs/agent-30days/day-16-supervisor-router) | runnable | [Dynamic Routing With a Supervisor: Structured-Output Routing, Override, routingReason](https://course.front-end-js.top/en/learn/agent-30days/day-16) |
| D17 | [`agent-30days/day-17-planner-executor-critic`](./labs/agent-30days/day-17-planner-executor-critic) | runnable | [Planner-Executor-Critic Plus a Shared Workspace: Workspace State, toolBudget, Parallel Fan-Out, a Review Loop](https://course.front-end-js.top/en/learn/agent-30days/day-17) |
| D18 | [`agent-30days/day-18-checkpointer-summary`](./labs/agent-30days/day-18-checkpointer-summary) | runnable | [History Fidelity and Summarization, Multimodal Placeholders, Checkpointer Persistence](https://course.front-end-js.top/en/learn/agent-30days/day-18) |
| D19 | [`agent-30days/day-19-cross-service-integration`](./labs/agent-30days/day-19-cross-service-integration) | runnable | [Cross-Service Agent Integration: Minting a User-Level JWT, JWKS Signature Verification, the inject/memory/usage Interfaces, Idempotent externalId](https://course.front-end-js.top/en/learn/agent-30days/day-19) |
| D20 | [`agent-30days/day-20-proactive-jobs`](./labs/agent-30days/day-20-proactive-jobs) | runnable | [Scheduled Jobs and Proactive Outreach: Time Zones, Quiet Hours, Daily Caps, a Notification Provider Abstraction](https://course.front-end-js.top/en/learn/agent-30days/day-20) |
| D21 | [`agent-30days/day-21-eval-and-tracing`](./labs/agent-30days/day-21-eval-and-tracing) | runnable | [Evaluation and Observability: a Golden Set, LLM-as-Judge, Tracing, a Failure-Rate/Cost Dashboard; Pi vs. LangGraph Summary; Week Three Retrospective](https://course.front-end-js.top/en/learn/agent-30days/day-21) |
| D22 | [`agent-30days/day-22-agent-security`](./labs/agent-30days/day-22-agent-security) | runnable | [Security: Prompt Injection, Least Privilege for Tools, Sandboxing Approaches, Secret Management](https://course.front-end-js.top/en/learn/agent-30days/day-22) |
| D23 | [`agent-30days/day-23-mcp-server`](./labs/agent-30days/day-23-mcp-server) | runnable | [MCP and Skills: the Protocol, Server/Client, How It Differs From Function Calling; a Tour of the Claude Agent SDK](https://course.front-end-js.top/en/learn/agent-30days/day-23) |
| D24 | [`agent-30days/day-24-rag-advanced`](./labs/agent-30days/day-24-rag-advanced) | runnable | [RAG, Level Up: Hybrid Search, Reranking, Citations, Recall Evaluation](https://course.front-end-js.top/en/learn/agent-30days/day-24) |
| D25 | [`agent-30days/day-25-streaming-frontend`](./labs/agent-30days/day-25-streaming-frontend) | runnable | [The Frontend Agent Experience: Streaming Rendering, Visualizing Tool Calls, Interrupt/Retry, SSE Hooks](https://course.front-end-js.top/en/learn/agent-30days/day-25) |
| D26 | [`agent-30days/day-26-system-design-templates`](./labs/agent-30days/day-26-system-design-templates) | doc | [System Design Deep Dive: Agent Platforms / Customer-Support Agents / Multi-Tenancy / Cost Control](https://course.front-end-js.top/en/learn/agent-30days/day-26) |
| D27 | [`agent-30days/day-27-resume-and-readme`](./labs/agent-30days/day-27-resume-and-readme) | doc | [Resume and Project Packaging: STAR, README, Architecture Diagrams, a Demo Video, an English Resume](https://course.front-end-js.top/en/learn/agent-30days/day-27) |

## [Prompt Engineering From Scratch in 5 Days](https://course.front-end-js.top/en/learn/prompt-engineering-5days)

5 labs

| Day | Lab | Type | Chapter |
|---|---|---|---|
| D1 | [`prompt-engineering-5days/day-01-four-part-template`](./labs/prompt-engineering-5days/day-01-four-part-template) | doc | [What a Prompt Is, and Isn't: How the Model Reads Instructions; the Four Elements of Role / Task / Format / Constraints](https://course.front-end-js.top/en/learn/prompt-engineering-5days/day-01) |
| D2 | [`prompt-engineering-5days/day-02-before-after-rewrites`](./labs/prompt-engineering-5days/day-02-before-after-rewrites) | doc | [Few-Shot, Chain of Thought, Step-by-Step, and Self-Checks; When None of These Work](https://course.front-end-js.top/en/learn/prompt-engineering-5days/day-02) |
| D3 | [`prompt-engineering-5days/day-03-structured-extraction`](./labs/prompt-engineering-5days/day-03-structured-extraction) | runnable | [Structured Output: JSON Schema, Templates and Variables, Multilingual Output](https://course.front-end-js.top/en/learn/prompt-engineering-5days/day-03) |
| D4 | [`prompt-engineering-5days/day-04-prompt-ab-eval`](./labs/prompt-engineering-5days/day-04-prompt-ab-eval) | runnable | [Iteration and Evaluation: Small Test Sets, A/B Testing, Version Control, Common Anti-Patterns](https://course.front-end-js.top/en/learn/prompt-engineering-5days/day-04) |
| D5 | [`prompt-engineering-5days/day-05-migration-checklist`](./labs/prompt-engineering-5days/day-05-migration-checklist) | doc | [Migrating Across Models: Differences Between Claude / GPT / Domestic Chinese Models, Organizing the System Prompt; Where to Go Next — the Claude Course or the Codex Course](https://course.front-end-js.top/en/learn/prompt-engineering-5days/day-05) |

## [Mastering Claude: From Conversation to Claude Code in 5 Days](https://course.front-end-js.top/en/learn/claude-mastery)

5 labs

| Day | Lab | Type | Chapter |
|---|---|---|---|
| D1 | [`claude-mastery/day-01-prompt-templates`](./labs/claude-mastery/day-01-prompt-templates) | doc | [Advanced Prompting and Claude's "Personality": System Prompt, XML Tags, Letting the Model Think First, Structured Output](https://course.front-end-js.top/en/learn/claude-mastery/day-01) |
| D2 | [`claude-mastery/day-02-pdf-cited-summary`](./labs/claude-mastery/day-02-pdf-cited-summary) | runnable | [Long Documents, Multimodal Input, and a First Look at the API: Using Large Context, Saving Money With Prompt Caching, PDF and Image Input, Citation-Backed Answers; a Minimal Messages API Call](https://course.front-end-js.top/en/learn/claude-mastery/day-02) |
| D3 | [`claude-mastery/day-03-first-claude-md`](./labs/claude-mastery/day-03-first-claude-md) | doc | [Getting Started With Claude Code and Managing Context: Install, Writing CLAUDE.md and "Trim Until You Can't", Permission Modes, Plan Mode's "Explore, Then Plan, Then Write", /clear /compact /rewind, Giving Claude a Verifiable Check](https://course.front-end-js.top/en/learn/claude-mastery/day-03) |
| D4 | [`claude-mastery/day-04-hooks-and-skill`](./labs/claude-mastery/day-04-hooks-and-skill) | runnable | [Extending Claude Code: Hooks (Deterministic) vs. CLAUDE.md (Advisory), Skills, Subagents, Plugins, Wiring Up an MCP Server, CLI Tools First](https://course.front-end-js.top/en/learn/claude-mastery/day-04) |
| D5 | [`claude-mastery/day-05-headless-ci`](./labs/claude-mastery/day-05-headless-ci) | runnable | [Automation and Scale: Headless -p Into CI, Parallel Sessions and Worktrees, Writer/Reviewer Dual Sessions, Adversarial Review, Common Failure Modes; a 20-Line Minimal Agent SDK Agent](https://course.front-end-js.top/en/learn/claude-mastery/day-05) |

## [Mastering Codex and the OpenAI Agents SDK in 5 Days](https://course.front-end-js.top/en/learn/codex-mastery)

5 labs

| Day | Lab | Type | Chapter |
|---|---|---|---|
| D1 | [`codex-mastery/day-01-agents-md`](./labs/codex-mastery/day-01-agents-md) | doc | [Getting Started With the Codex CLI: Install, AGENTS.md, Approval Modes and the Sandbox, Common Commands](https://course.front-end-js.top/en/learn/codex-mastery/day-01) |
| D2 | [`codex-mastery/day-02-cloud-task-checklist`](./labs/codex-mastery/day-02-cloud-task-checklist) | doc | [Codex, Level Up: Cloud Tasks, Code Review, MCP Integration, Custom Instructions, IDE Integration](https://course.front-end-js.top/en/learn/codex-mastery/day-02) |
| D3 | [`codex-mastery/day-03-responses-tools`](./labs/codex-mastery/day-03-responses-tools) | runnable | [The Responses API and Built-in Tools: Function Calling, Web Search / File Search / Computer Use, Structured Output](https://course.front-end-js.top/en/learn/codex-mastery/day-03) |
| D4 | [`codex-mastery/day-04-handoff-guardrail`](./labs/codex-mastery/day-04-handoff-guardrail) | runnable | [The OpenAI Agents SDK: Agents, Handoffs, Guardrails, Sessions, Tracing](https://course.front-end-js.top/en/learn/codex-mastery/day-04) |
| D5 | [`codex-mastery/day-05-dual-tool-compare`](./labs/codex-mastery/day-05-dual-tool-compare) | runnable | [Choosing and Combining Claude and Codex: A Real Side-by-Side on the Same Task, a Write-One-Review-One Mixed Workflow](https://course.front-end-js.top/en/learn/codex-mastery/day-05) |

## [MCP in 7 Days: Wire Tools Into Any Agent](https://course.front-end-js.top/en/learn/mcp-7days)

7 labs

| Day | Lab | Type | Chapter |
|---|---|---|---|
| D1 | [`mcp-7days/day-01-annotate-json-rpc`](./labs/mcp-7days/day-01-annotate-json-rpc) | doc | [Why a Protocol: the Host/Client/Server Triangle, JSON-RPC Messages, and Three Primitives](https://course.front-end-js.top/en/learn/mcp-7days/day-01) |
| D2 | [`mcp-7days/day-02-weather-fx-server`](./labs/mcp-7days/day-02-weather-fx-server) | runnable | [Writing Your First MCP Server: stdio Transport, the Official SDK, Parameter Schemas, Tool Annotations, and Debugging With Inspector](https://course.front-end-js.top/en/learn/mcp-7days/day-02) |
| D3 | [`mcp-7days/day-03-notes-resource-server`](./labs/mcp-7days/day-03-notes-resource-server) | runnable | [Resources and Prompts: URI Templates, Change Notifications, Progress and Logging, Pagination, and Client Capabilities](https://course.front-end-js.top/en/learn/mcp-7days/day-03) |
| D4 | [`mcp-7days/day-04-streamable-http-deploy`](./labs/mcp-7days/day-04-streamable-http-deploy) | runnable | [Remote MCP: the Streamable HTTP Binding, the Stateless Model and Request Metadata, OAuth 2.1 Authorization, Container Deployment](https://course.front-end-js.top/en/learn/mcp-7days/day-04) |
| D5 | [`mcp-7days/day-05-agent-mcp-client`](./labs/mcp-7days/day-05-agent-mcp-client) | runnable | [Writing an MCP Client: Discovering and Calling Tools Inside Your Own Agent Loop, Multi-Server Aggregation and Name Collisions](https://course.front-end-js.top/en/learn/mcp-7days/day-05) |
| D6 | [`mcp-7days/day-06-server-security-checklist`](./labs/mcp-7days/day-06-server-security-checklist) | doc | [Security and Governance: Prompt Injection in Tool Descriptions, the Confused Deputy, Least Privilege, Audit Logs, and a Tool Allowlist](https://course.front-end-js.top/en/learn/mcp-7days/day-06) |
| D7 | [`mcp-7days/day-07-publishable-server-template`](./labs/mcp-7days/day-07-publishable-server-template) | runnable | [Productionizing and Retrospective: Writing Evals for Tools, Versioning, Publishing to npm and a Registry, Observability, and a Capstone Project](https://course.front-end-js.top/en/learn/mcp-7days/day-07) |

## [Agent Skills in 7 Days: Turn Experience Into Reusable Capability](https://course.front-end-js.top/en/learn/agent-skills-7days)

7 labs

| Day | Lab | Type | Chapter |
|---|---|---|---|
| D1 | [`agent-skills-7days/day-01-skill-anatomy`](./labs/agent-skills-7days/day-01-skill-anatomy) | doc | [What Skills Are: the SKILL.md Spec, Directory Layout, and Three-Stage Progressive Disclosure](https://course.front-end-js.top/en/learn/agent-skills-7days/day-01) |
| D2 | [`agent-skills-7days/day-02-commit-message-skill`](./labs/agent-skills-7days/day-02-commit-message-skill) | doc | [Writing Your First Skill: How to Write description's Trigger Words, How to Layer the Structure, How to Install It Into a Client](https://course.front-end-js.top/en/learn/agent-skills-7days/day-02) |
| D3 | [`agent-skills-7days/day-03-trigger-eval`](./labs/agent-skills-7days/day-03-trigger-eval) | runnable | [A Design Method: Distilling From Repeated Tasks, Checklist Style vs. Reference-Manual Style, Four Anti-Patterns, and Trigger Testing](https://course.front-end-js.top/en/learn/agent-skills-7days/day-03) |
| D4 | [`agent-skills-7days/day-04-doc-skill-with-scripts`](./labs/agent-skills-7days/day-04-doc-skill-with-scripts) | runnable | [Skills With Scripts: Executable Attachments, Dependencies and Sandboxing, Cross-Platform Support, and Breaking Down Document-Handling Skills](https://course.front-end-js.top/en/learn/agent-skills-7days/day-04) |
| D5 | [`agent-skills-7days/day-05-skill-runtime`](./labs/agent-skills-7days/day-05-skill-runtime) | runnable | [Hand-Building a Skill Runtime: Scanning, Frontmatter Parsing, Injecting the System Prompt, Reading the Body on Demand](https://course.front-end-js.top/en/learn/agent-skills-7days/day-05) |
| D6 | [`agent-skills-7days/day-06-skill-plugin-pack`](./labs/agent-skills-7days/day-06-skill-plugin-pack) | doc | [Organizing and Distributing: Plugins and Marketplaces, Versioning and Team Sharing, and the Division of Labor Between Function Calling, MCP, and Skills](https://course.front-end-js.top/en/learn/agent-skills-7days/day-06) |
| D7 | [`agent-skills-7days/day-07-team-skill-pack`](./labs/agent-skills-7days/day-07-team-skill-pack) | doc | [Capstone and Retrospective: Turning a Team's Conventions Into a Skill Pack and Driving a Subagent Through a Real Task](https://course.front-end-js.top/en/learn/agent-skills-7days/day-07) |

## [Context Engineering in 5 Days](https://course.front-end-js.top/en/learn/context-engineering-5days)

5 labs

| Day | Lab | Type | Chapter |
|---|---|---|---|
| D1 | [`context-engineering-5days/day-01-context-profile`](./labs/context-engineering-5days/day-01-context-profile) | runnable | [Context Is the Scarcest Resource: the Window, Attention Decay, and Cost — From Prompt Engineering to Context Engineering](https://course.front-end-js.top/en/learn/context-engineering-5days/day-01) |
| D2 | [`context-engineering-5days/day-02-instruction-file`](./labs/context-engineering-5days/day-02-instruction-file) | doc | [System Prompts and the Instruction Hierarchy: the Right Altitude, Persistent Instruction Files, Progressive Disclosure, Less Is More](https://course.front-end-js.top/en/learn/context-engineering-5days/day-02) |
| D3 | [`context-engineering-5days/day-03-tool-result-trimmer`](./labs/context-engineering-5days/day-03-tool-result-trimmer) | runnable | [Managing Context for Tool Results and Retrieval: Loading on Demand, Summarizing and Pruning, Structured Returns](https://course.front-end-js.top/en/learn/context-engineering-5days/day-03) |
| D4 | [`context-engineering-5days/day-04-compaction-strategy`](./labs/context-engineering-5days/day-04-compaction-strategy) | runnable | [Long-Running Sessions: Compression, Notes and Memory Files, Subagent Isolation and Handoff Summaries](https://course.front-end-js.top/en/learn/context-engineering-5days/day-04) |
| D5 | [`context-engineering-5days/day-05-tuning-report`](./labs/context-engineering-5days/day-05-tuning-report) | doc | [Measuring and Tuning: the Token Bill, Context Utilization, Failure-Mode Triage, and a Comprehensive Interview Deep Dive](https://course.front-end-js.top/en/learn/context-engineering-5days/day-05) |

## [Frontend Agent UX in 7 Days: From Streaming to Generative UI](https://course.front-end-js.top/en/learn/frontend-agent-ux-7days)

7 labs

| Day | Lab | Type | Chapter |
|---|---|---|---|
| D1 | [`frontend-agent-ux-7days/day-01-first-stream`](./labs/frontend-agent-ux-7days/day-01-first-stream) | runnable | [What Makes Agent Frontends Hard: an Event Protocol and Your First Stream in the Browser](https://course.front-end-js.top/en/learn/frontend-agent-ux-7days/day-01) |
| D2 | [`frontend-agent-ux-7days/day-02-steady-stream`](./labs/frontend-agent-ux-7days/day-02-steady-stream) | runnable | [Streaming Without Jank: Render Storms, Incremental Markdown, and Scroll Anchoring](https://course.front-end-js.top/en/learn/frontend-agent-ux-7days/day-02) |
| D3 | [`frontend-agent-ux-7days/day-03-tool-approval`](./labs/frontend-agent-ux-7days/day-03-tool-approval) | runnable | [Tool Call Visualization and Humans in the Loop: Interruption Is Not Local Interception](https://course.front-end-js.top/en/learn/frontend-agent-ux-7days/day-03) |
| D4 | [`frontend-agent-ux-7days/day-04-reasoning-state`](./labs/frontend-agent-ux-7days/day-04-reasoning-state) | runnable | [Reasoning and Shared State: a Collapsible Thinking Panel and Incremental Sync](https://course.front-end-js.top/en/learn/frontend-agent-ux-7days/day-04) |
| D5 | [`frontend-agent-ux-7days/day-05-generative-ui`](./labs/frontend-agent-ux-7days/day-05-generative-ui) | runnable | [Three Paradigms of Generative UI: From Component Mapping to Declarative Interfaces](https://course.front-end-js.top/en/learn/frontend-agent-ux-7days/day-05) |
| D6 | [`frontend-agent-ux-7days/day-06-workbench`](./labs/frontend-agent-ux-7days/day-06-workbench) | runnable | [Session Control and Long Tasks: Stopping, Retrying, Branching, and Subagents](https://course.front-end-js.top/en/learn/frontend-agent-ux-7days/day-06) |
| D7 | [`frontend-agent-ux-7days/day-07-accessible-workbench`](./labs/frontend-agent-ux-7days/day-07-accessible-workbench) | runnable | [Accessibility and Performance Budgets: Making Streaming Interfaces Work for Everyone](https://course.front-end-js.top/en/learn/frontend-agent-ux-7days/day-07) |

## [RAG in 14 Days: From Retrieval to Trustworthy Answers](https://course.front-end-js.top/en/learn/rag-14days)

14 labs

| Day | Lab | Type | Chapter |
|---|---|---|---|
| D1 | [`rag-14days/day-01-bm25-mini-rag`](./labs/rag-14days/day-01-bm25-mini-rag) | runnable | [Why Retrieve at All: Hallucination, Knowledge Cutoffs, and the Cost of Long Context; a Minimal Keyword-Only RAG](https://course.front-end-js.top/en/learn/rag-14days/day-01) |
| D2 | [`rag-14days/day-02-pgvector-nearest-neighbor`](./labs/rag-14days/day-02-pgvector-nearest-neighbor) | runnable | [Embeddings and Vector Search: Similarity, Dimensionality, and Model Choice; Storing Text in pgvector](https://course.front-end-js.top/en/learn/rag-14days/day-02) |
| D3 | [`rag-14days/day-03-document-parsing-pipeline`](./labs/rag-14days/day-03-document-parsing-pipeline) | runnable | [Getting Documents In: Parsing PDF and HTML, Tables and Scans, Cleaning Rules, and Metadata You Must Keep](https://course.front-end-js.top/en/learn/rag-14days/day-03) |
| D4 | [`rag-14days/day-04-chunking-strategies`](./labs/rag-14days/day-04-chunking-strategies) | runnable | [Chunking Strategies: Five Approaches — Fixed, Recursive, Structure-Based, Parent-Child, and Semantic — and Choosing by Evaluation, Not Intuition](https://course.front-end-js.top/en/learn/rag-14days/day-04) |
| D5 | [`rag-14days/day-05-index-tuning-and-filters`](./labs/rag-14days/day-05-index-tuning-and-filters) | runnable | [Vector Indexes and Store Selection: HNSW vs. Inverted File, Quantization to Save Memory, Filtered Queries and Multi-Tenant Isolation](https://course.front-end-js.top/en/learn/rag-14days/day-05) |
| D6 | [`rag-14days/day-06-cited-answer-api`](./labs/rag-14days/day-06-cited-answer-api) | runnable | [The Generation Side: Ordering Context, Labeling Citations, When You Must Refuse to Answer, and Streaming Responses](https://course.front-end-js.top/en/learn/rag-14days/day-06) |
| D7 | [`rag-14days/day-07-rag-service`](./labs/rag-14days/day-07-rag-service) | runnable | [Week One Capstone: Assembling Six Days of Parts Into a One-Command Question-Answering Service, and a Retrospective](https://course.front-end-js.top/en/learn/rag-14days/day-07) |
| D8 | [`rag-14days/day-08-eval-harness`](./labs/rag-14days/day-08-eval-harness) | runnable | [Evaluation First: Building a Golden Set, Computing Recall and Ranking Metrics, Using a Model as Judge for Faithfulness](https://course.front-end-js.top/en/learn/rag-14days/day-08) |
| D9 | [`rag-14days/day-09-hybrid-and-rerank`](./labs/rag-14days/day-09-hybrid-and-rerank) | runnable | [Hybrid Search and Reranking: Two-Path Retrieval, Reciprocal Rank Fusion, Then Re-Ranking the Top Results With a Cross-Encoder](https://course.front-end-js.top/en/learn/rag-14days/day-09) |
| D10 | [`rag-14days/day-10-query-transformations`](./labs/rag-14days/day-10-query-transformations) | runnable | [Query-Side Optimization: Rewriting, Hypothetical Document Embeddings, Multi-Query, Step-Back Prompting, and Intent Routing](https://course.front-end-js.top/en/learn/rag-14days/day-10) |
| D11 | [`rag-14days/day-11-parent-child-and-contextual`](./labs/rag-14days/day-11-parent-child-and-contextual) | runnable | [Advanced Indexing: Parent-Child Documents, Summary Indexes, Contextual Retrieval, and the Trade-Offs of Tree Aggregation vs. Graph Retrieval](https://course.front-end-js.top/en/learn/rag-14days/day-11) |
| D12 | [`rag-14days/day-12-agentic-retrieval`](./labs/rag-14days/day-12-agentic-retrieval) | runnable | [Agentic RAG: Turning Retrieval Into a Tool So the Model Decides Whether to Search, How Many Times, and Whether to Start Over](https://course.front-end-js.top/en/learn/rag-14days/day-12) |
| D13 | [`rag-14days/day-13-incremental-and-acl`](./labs/rag-14days/day-13-incremental-and-acl) | runnable | [Going to Production: Incremental Sync and Deduplication, Permission-Based Filtering, Cache Layering, Tracing, and the Cost-Latency Ledger](https://course.front-end-js.top/en/learn/rag-14days/day-13) |
| D14 | [`rag-14days/day-14-capstone-knowledge-base`](./labs/rag-14days/day-14-capstone-knowledge-base) | runnable | [Capstone Project and Retrospective: A Multi-Tenant Enterprise Knowledge-Base Q&A, a RAG Decision Map, and an Interview Deep Dive](https://course.front-end-js.top/en/learn/rag-14days/day-14) |

## [Build an AI Short-Drama Production Pipeline With Agents in 14 Days](https://course.front-end-js.top/en/learn/ai-drama-pipeline)

14 labs

| Day | Lab | Type | Chapter |
|---|---|---|---|
| D1 | [`ai-drama-pipeline/day-01-pipeline-skeleton`](./labs/ai-drama-pipeline/day-01-pipeline-skeleton) | runnable | [What an AI Short-Drama Production Pipeline Looks Like: Breaking Down the Stages, a Task-Graph Architecture, and Choosing Among Four Categories of Generation Models](https://course.front-end-js.top/en/learn/ai-drama-pipeline/day-01) |
| D2 | [`ai-drama-pipeline/day-02-script-agent`](./labs/ai-drama-pipeline/day-02-script-agent) | runnable | [The Script Agent: Turning a Single Sentence Into Structured Data — Character Cards, Scenes, and Shots](https://course.front-end-js.top/en/learn/ai-drama-pipeline/day-02) |
| D3 | [`ai-drama-pipeline/day-03-character-assets`](./labs/ai-drama-pipeline/day-03-character-assets) | runnable | [Character Consistency: Character Sheets, Reference Images, and Style Locking — Keeping the Same Person the Same Person in Every Shot](https://course.front-end-js.top/en/learn/ai-drama-pipeline/day-03) |
| D4 | [`ai-drama-pipeline/day-04-shot-video`](./labs/ai-drama-pipeline/day-04-shot-video) | runnable | [From Shot to Footage: Image-to-Video, Polling Async Tasks, and Retrying Failures](https://course.front-end-js.top/en/learn/ai-drama-pipeline/day-04) |
| D5 | [`ai-drama-pipeline/day-05-voice-subtitle`](./labs/ai-drama-pipeline/day-05-voice-subtitle) | runnable | [Voiceover, Subtitles, and Audio Tracks: Multi-Character Voices, Timeline Alignment, and Subtitle Files](https://course.front-end-js.top/en/learn/ai-drama-pipeline/day-05) |
| D6 | [`ai-drama-pipeline/day-06-ffmpeg-compose`](./labs/ai-drama-pipeline/day-06-ffmpeg-compose) | runnable | [The Editing Bay: Assembling Footage Into One Vertical Cut With ffmpeg](https://course.front-end-js.top/en/learn/ai-drama-pipeline/day-06) |
| D7 | [`ai-drama-pipeline/day-07-end-to-end`](./labs/ai-drama-pipeline/day-07-end-to-end) | runnable | [One Episode Wrapped: Stringing Six Stages Into an End-to-End Pipeline and Tallying the First Bill](https://course.front-end-js.top/en/learn/ai-drama-pipeline/day-07) |
| D8 | [`ai-drama-pipeline/day-08-workflow-engine`](./labs/ai-drama-pipeline/day-08-workflow-engine) | runnable | [A Workflow Engine: Turning the Pipeline Into a Resumable Task Graph](https://course.front-end-js.top/en/learn/ai-drama-pipeline/day-08) |
| D9 | [`ai-drama-pipeline/day-09-parallel-episodes`](./labs/ai-drama-pipeline/day-09-parallel-episodes) | runnable | [Concurrency and Quotas: Starting Multiple Episodes at Once Without Blowing Through Any Provider's Limits](https://course.front-end-js.top/en/learn/ai-drama-pipeline/day-09) |
| D10 | [`ai-drama-pipeline/day-10-review-console`](./labs/ai-drama-pipeline/day-10-review-console) | runnable | [The Review Room: A Human-in-the-Loop Backend for Previewing, Editing Lines, and Regenerating a Single Shot](https://course.front-end-js.top/en/learn/ai-drama-pipeline/day-10) |
| D11 | [`ai-drama-pipeline/day-11-qc-compliance`](./labs/ai-drama-pipeline/day-11-qc-compliance) | runnable | [Quality Control and Compliance: Machine Review, Content Safety, Generated-Content Labeling, and Copyright Boundaries](https://course.front-end-js.top/en/learn/ai-drama-pipeline/day-11) |
| D12 | [`ai-drama-pipeline/day-12-cost-router`](./labs/ai-drama-pipeline/day-12-cost-router) | runnable | [Cost and Model Routing: Choosing a Model per Stage, Caching, Degradation, and a Budget Circuit Breaker](https://course.front-end-js.top/en/learn/ai-drama-pipeline/day-12) |
| D13 | [`ai-drama-pipeline/day-13-multi-platform-export`](./labs/ai-drama-pipeline/day-13-multi-platform-export) | runnable | [Distribution: Adapting to Multiple Platform Specs, Generating Covers and Titles, Batch Export, and Feeding Data Back](https://course.front-end-js.top/en/learn/ai-drama-pipeline/day-13) |
| D14 | [`ai-drama-pipeline/day-14-season-portfolio`](./labs/ai-drama-pipeline/day-14-season-portfolio) | runnable | [A Five-Episode Season: Batch Production, Portfolio Packaging, and a Short-Drama Pipeline Interview Deep Dive](https://course.front-end-js.top/en/learn/ai-drama-pipeline/day-14) |

## [Build Your Own Coding Agent in 21 Days](https://course.front-end-js.top/en/learn/my-coding-agent-21days)

21 labs

| Day | Lab | Type | Chapter |
|---|---|---|---|
| D1 | [`my-coding-agent-21days/day-01-repl-skeleton`](./labs/my-coding-agent-21days/day-01-repl-skeleton) | runnable | [What Layers Make Up a Coding Agent: the REPL Skeleton, the Command System, and a Provider-Neutral Gateway Abstraction](https://course.front-end-js.top/en/learn/my-coding-agent-21days/day-01) |
| D2 | [`my-coding-agent-21days/day-02-streaming-render`](./labs/my-coding-agent-21days/day-02-streaming-render) | runnable | [Streaming Output and Terminal Rendering: Hand-Writing an SSE Parser, Incremental Markdown, and an Interruptible Typewriter](https://course.front-end-js.top/en/learn/my-coding-agent-21days/day-02) |
| D3 | [`my-coding-agent-21days/day-03-readonly-tools`](./labs/my-coding-agent-21days/day-03-readonly-tools) | runnable | [The Tool Protocol and the Read-Only Trio: Schema Design, Chunk Merging, and Result Truncation](https://course.front-end-js.top/en/learn/my-coding-agent-21days/day-03) |
| D4 | [`my-coding-agent-21days/day-04-edit-and-shell`](./labs/my-coding-agent-21days/day-04-edit-and-shell) | runnable | [File Editing and Shell Execution: Exact-Match Replacement, Conflict Detection, and a Timeout-Killable Subprocess](https://course.front-end-js.top/en/learn/my-coding-agent-21days/day-04) |
| D5 | [`my-coding-agent-21days/day-05-approval-gate`](./labs/my-coding-agent-21days/day-05-approval-gate) | runnable | [Permissions and Approval: a Three-State Rule Set, Matching by Tool and Path, and the Boundaries of Auto Mode](https://course.front-end-js.top/en/learn/my-coding-agent-21days/day-05) |
| D6 | [`my-coding-agent-21days/day-06-error-recovery`](./labs/my-coding-agent-21days/day-06-error-recovery) | runnable | [Error Handling and Self-Correction: Feeding Failures Back, Backoff Retries, Loop Detection, and Cancellation](https://course.front-end-js.top/en/learn/my-coding-agent-21days/day-06) |
| D7 | [`my-coding-agent-21days/day-07-session-resume`](./labs/my-coding-agent-21days/day-07-session-resume) | runnable | [Session Persistence and Recovery: an Append-Only Event Log, Resume and Forking, Week One Retrospective](https://course.front-end-js.top/en/learn/my-coding-agent-21days/day-07) |
| D8 | [`my-coding-agent-21days/day-08-at-references`](./labs/my-coding-agent-21days/day-08-at-references) | runnable | [Reference Injection: Parsing @ Files, Directories, URLs, and Images, and Accounting for What Got Injected](https://course.front-end-js.top/en/learn/my-coding-agent-21days/day-08) |
| D9 | [`my-coding-agent-21days/day-09-project-instructions`](./labs/my-coding-agent-21days/day-09-project-instructions) | runnable | [Project Instruction Files: Three-Tier Loading, Import Expansion, and the System Prompt's Merge Order](https://course.front-end-js.top/en/learn/my-coding-agent-21days/day-09) |
| D10 | [`my-coding-agent-21days/day-10-todo-tracking`](./labs/my-coding-agent-21days/day-10-todo-tracking) | runnable | [Task Lists and Self-Planning: the Todo Tool, Progress Rendering, and Early Detection of Spinning](https://course.front-end-js.top/en/learn/my-coding-agent-21days/day-10) |
| D11 | [`my-coding-agent-21days/day-11-memory`](./labs/my-coding-agent-21days/day-11-memory) | runnable | [Cross-Session Memory: Explicit Memory, Automatic Memory, and Three Criteria for Retrieval Injection](https://course.front-end-js.top/en/learn/my-coding-agent-21days/day-11) |
| D12 | [`my-coding-agent-21days/day-12-context-compaction`](./labs/my-coding-agent-21days/day-12-context-compaction) | runnable | [Context Compression: How to Count Tokens, What to Compress and What to Keep, and How to Verify Nothing Was Lost](https://course.front-end-js.top/en/learn/my-coding-agent-21days/day-12) |
| D13 | [`my-coding-agent-21days/day-13-plan-mode`](./labs/my-coding-agent-21days/day-13-plan-mode) | runnable | [Ask Before Acting: a Structured Question Tool, a Read-Only Exploration Mode, and Plan Approval](https://course.front-end-js.top/en/learn/my-coding-agent-21days/day-13) |
| D14 | [`my-coding-agent-21days/day-14-checkpoint-rewind`](./labs/my-coding-agent-21days/day-14-checkpoint-rewind) | runnable | [Checkpoints and Rewind: File Snapshots, Conversation Rollback, and Why the Two Must Stay Independent](https://course.front-end-js.top/en/learn/my-coding-agent-21days/day-14) |
| D15 | [`my-coding-agent-21days/day-15-mcp-client`](./labs/my-coding-agent-21days/day-15-mcp-client) | runnable | [Wiring Up MCP: a Hand-Written JSON-RPC Client, Two Transports, and a Tool Namespace](https://course.front-end-js.top/en/learn/my-coding-agent-21days/day-15) |
| D16 | [`my-coding-agent-21days/day-16-skill-loader`](./labs/my-coding-agent-21days/day-16-skill-loader) | runnable | [Loading Skills: Scanning, Progressive Disclosure, and Trigger Judgment — Bringing Experience to the Table on Demand](https://course.front-end-js.top/en/learn/my-coding-agent-21days/day-16) |
| D17 | [`my-coding-agent-21days/day-17-subagents`](./labs/my-coding-agent-21days/day-17-subagents) | runnable | [Subagents and Parallelism: Independent Context, a Tool Allowlist, Worktree Isolation, and Result Aggregation](https://course.front-end-js.top/en/learn/my-coding-agent-21days/day-17) |
| D18 | [`my-coding-agent-21days/day-18-hooks`](./labs/my-coding-agent-21days/day-18-hooks) | runnable | [Hooks and Background Tasks: Lifecycle Hooks, Deterministic Checks, and Notifications That Don't Interrupt the Conversation](https://course.front-end-js.top/en/learn/my-coding-agent-21days/day-18) |
| D19 | [`my-coding-agent-21days/day-19-multimodal`](./labs/my-coding-agent-21days/day-19-multimodal) | runnable | [Multimodal Input: Pasting Screenshots, Image Validation, and Fixing Code From a Screenshot](https://course.front-end-js.top/en/learn/my-coding-agent-21days/day-19) |
| D20 | [`my-coding-agent-21days/day-20-evals-and-cost`](./labs/my-coding-agent-21days/day-20-evals-and-cost) | runnable | [Evaluation and Cost: Designing a Benchmark Set, Computing Pass Rate, and Reading Token Usage and Cache Hits](https://course.front-end-js.top/en/learn/my-coding-agent-21days/day-20) |
| D21 | [`my-coding-agent-21days/day-21-ship-it`](./labs/my-coding-agent-21days/day-21-ship-it) | runnable | [Packaging and Release: a Global Command, a Config Directory, Versioning and Updates — a Twenty-One-Day Retrospective](https://course.front-end-js.top/en/learn/my-coding-agent-21days/day-21) |

## [Agent Evals and Observability in 7 Days: Turning "Seems Fine" Into Numbers You Can Reproduce](https://course.front-end-js.top/en/learn/agent-evals-7days)

7 labs

| Day | Lab | Type | Chapter |
|---|---|---|---|
| D1 | [`agent-evals-7days/day-01-first-eval`](./labs/agent-evals-7days/day-01-first-eval) | runnable | [Why You Cannot Ship an Agent on "I Tried It a Few Times"](https://course.front-end-js.top/en/learn/agent-evals-7days/day-01) |
| D2 | [`agent-evals-7days/day-02-golden-set`](./labs/agent-evals-7days/day-02-golden-set) | runnable | [Benchmark Sets: Turning the Incidents You Already Had Into Reproducible Tasks](https://course.front-end-js.top/en/learn/agent-evals-7days/day-02) |
| D3 | [`agent-evals-7days/day-03-llm-judge`](./labs/agent-evals-7days/day-03-llm-judge) | runnable | [Let a Model Judge, Then Put the Judge Through an Exam](https://course.front-end-js.top/en/learn/agent-evals-7days/day-03) |
| D4 | [`agent-evals-7days/day-04-trajectory`](./labs/agent-evals-7days/day-04-trajectory) | runnable | [Trajectory Evaluation: It Reached the Destination, but How Many Things Did It Hit](https://course.front-end-js.top/en/learn/agent-evals-7days/day-04) |
| D5 | [`agent-evals-7days/day-05-tracing`](./labs/agent-evals-7days/day-05-tracing) | runnable | [Observability: Putting a Flight Recorder on Every Run](https://course.front-end-js.top/en/learn/agent-evals-7days/day-05) |
| D6 | [`agent-evals-7days/day-06-ci-gate`](./labs/agent-evals-7days/day-06-ci-gate) | runnable | [The Regression Gate: Blocking a Drop Before It Merges](https://course.front-end-js.top/en/learn/agent-evals-7days/day-06) |
| D7 | [`agent-evals-7days/day-07-suite-health`](./labs/agent-evals-7days/day-07-suite-health) | runnable | [Examining the Suite Itself: Saturation, Broken Tasks and Grading Defects](https://course.front-end-js.top/en/learn/agent-evals-7days/day-07) |

## [Agent Security in 5 Days](https://course.front-end-js.top/en/learn/agent-security-5days)

5 labs

| Day | Lab | Type | Chapter |
|---|---|---|---|
| D1 | [`agent-security-5days/day-01-threat-model`](./labs/agent-security-5days/day-01-threat-model) | runnable | [Threat modelling: the lethal trifecta, trust boundaries, and how to use two OWASP lists as checklists](https://course.front-end-js.top/en/learn/agent-security-5days/day-01) |
| D2 | [`agent-security-5days/day-02-injection-range`](./labs/agent-security-5days/day-02-injection-range) | runnable | [An injection range and the input side: what four tiers of defence stop, and where each one fails](https://course.front-end-js.top/en/learn/agent-security-5days/day-02) |
| D3 | [`agent-security-5days/day-03-secure-patterns`](./labs/agent-security-5days/day-03-secure-patterns) | runnable | [Architectural defence: six design patterns, and how plan-then-execute drives attack success to zero](https://course.front-end-js.top/en/learn/agent-security-5days/day-03) |
| D4 | [`agent-security-5days/day-04-sandboxed-executor`](./labs/agent-security-5days/day-04-sandboxed-executor) | runnable | [Runtime controls: capabilities, approval gates, egress allowlists, sandbox layers, secrets and tenancy](https://course.front-end-js.top/en/learn/agent-security-5days/day-04) |
| D5 | [`agent-security-5days/day-05-red-team-loop`](./labs/agent-security-5days/day-05-red-team-loop) | runnable | [Red teaming: keeping an attack suite alive, wiring it into CI, and what to do after an incident](https://course.front-end-js.top/en/learn/agent-security-5days/day-05) |

---

**129 labs** across 13 courses — 112 runnable, 17 doc-only. Generated by `scripts/build-labs-index.mjs` in the course repository — edit that, not this file.
