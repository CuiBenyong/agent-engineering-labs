# English Résumé (示范样例 · one page)

> 同 `resume-cn.md`：**个人信息一律是占位符**，样例不替你编履历；
> **项目那一栏的数字是真的**，来自本仓库实验的实测输出（复现命令见 `star-bullets.md`）。
>
> 注意这不是 `resume-cn.md` 的直译。对照着读，你会看到三处刻意的改写：
> Summary 去掉了中文里那串并列名词、项目要点全部改成动词开头、
> 测量条件从中文的括号补语改成了英文习惯的句末 parenthetical。

---

**（Your Name）** · （City, Country） · （+86 …） · （email）
github.com/（your-id） · （linkedin / personal site）
_Open to relocation.（签证状态按目标市场决定要不要写；含糊其辞会被默认为不可行。）_

## Summary

Frontend engineer moving into LLM agent infrastructure. Built three projects end to end: a streaming agent service, a sharded multi-worker execution platform, and a multi-agent orchestration service. Comfortable with SSE streaming, message-bus consumer groups with lease-based sharding, and graph orchestration with shared state. Looking for an agent or backend engineering role.

## Skills

**Languages** TypeScript, JavaScript, Python (read and modify)
**Runtime & Frameworks** Node.js, Fastify, React, LangGraph
**Data & Infra** PostgreSQL (incl. pgvector), Redis Streams, Drizzle ORM
**Tooling** Docker Compose, Vitest, Playwright, pnpm workspaces

## Projects

### mini-multi-agent · Course project · （mmm yyyy – mmm yyyy）

Multi-agent orchestration service: planner, executor and critic roles over a shared workspace, with per-task tool budgets and a review loop. [repo](…) · [demo](…)

- Replaced the `workspace` channel's append reducer with an upsert-by-id reducer so that parallel executors stop leaving stale copies of the same subtask, cutting records from **6 (3 duplicate ids, lookups returning the stale `pending` version)** to **3 (0 duplicates, lookups returning `done`)** _(local single process, mock mode, same graph with only the reducer swapped, 3 parallel subtasks)_.
- Capped each subtask at 5 tool calls and the critic at 2 rejections, degrading to partial results with a `degraded` flag instead of throwing and losing the whole graph run.
- **Stack:** TypeScript, LangGraph, PostgreSQL (custom checkpointer), JWT/JWKS service-to-service auth

### mini-koda · Course project · （mmm yyyy – mmm yyyy）

Agent execution platform splitting a stateless gateway from a worker pool, decoupled by a message bus, with strict per-user ordering. [repo](…) · [demo](…)

- Added `SET NX` + TTL shard leases, made "verify holder and extend" a single atomic step, and fenced every write with a monotonic token, so a failed holder is taken over in **2.75s** with per-user sequence numbers still contiguous (`[1,2,3,4,5,6]`) and the stale holder's renewals and writes both rejected _(local single process running 2 workers, in-memory infra, 2,000 simulated users across 256 shards, largest bucket 19; self-test compresses the production 30s TTL / 10s renewal by 10x)_.
- Built a per-token cost ledger with the amount denormalized at write time — unit prices change, historical invoices must not.
- **Stack:** TypeScript, Fastify, Redis Streams, PostgreSQL, Drizzle, Docker Compose

### agent-service · Course project · （mmm yyyy – mmm yyyy）

Single agent wrapped as an HTTP service with streaming output and graceful shutdown, runnable from one container. [repo](…) · [demo](…)

- Wired the request abort signal into the SSE generator and checked it before each `yield`, cutting server-side generation for an abandoned session from **103 chunks** to **6** — the client leaves after 5 and the server stops one chunk later _(local single process, mock mode, ~103-character canned reply)_.
- **Stack:** TypeScript, Fastify, SSE, Docker

## Experience

> TODO（必须你自己写，样例不代填）：reverse chronological, most recent first.
> Same shape as above: **verb first, past tense, quantified result with its measurement context.**
>
> 中英差异最典型的一处就在这里。中文简历常写「负责 XX 模块的开发与维护」，
> 直译成 `Responsible for the development and maintenance of the XX module` 是本文件的头号反例。
> 改写成你做成了什么：
> `Rebuilt the XX module's rendering path, cutting first paint from 2.4s to 0.9s.`

## Education

> TODO：University · Degree, Major · years. 工作三年以上放最后，一到两行。
> 国内学校用官方英文名，不要自己音译。GPA 不突出就不写。

---

## 交付前自检

- [x] One page (checked in print preview)
- [x] Every bullet starts with a past-tense verb
- [x] `Responsible for` / `Helped` / `Worked on` / `Participated` — zero hits **in the résumé body**（本文件里仅有的两处出现在上面的反例说明和这一行自检里，你自己那份应该是真正的零命中）
- [x] No photo, age, gender, marital status or ID number
- [x] All three learning projects labelled `Course project`, under `Projects` not `Experience`
- [x] Every number carries its measurement context in parentheses
- [x] Reads fine with all adjectives deleted
- [ ] Experience and Education filled in（样例留空，必须你自己补）
