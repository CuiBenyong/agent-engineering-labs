# AI Agent Engineering Labs

> 129 labs across 13 AI engineering courses. **112 of them are runnable code that works fully offline — no API key required.** The other 17 are doc-only (prompt templates, checklists, `SKILL.md` files) and don't need code.
>
> [中文](./README.md) · [Lab index](./INDEX.en.md) · [The courses](https://course.front-end-js.top/en)

This is the companion code for [Dayward AI](https://course.front-end-js.top/en). Every day of every course has a lab; all of it is here, MIT licensed.

## Running one in thirty seconds

Each lab is a self-contained package with no dependency on the rest of the repo:

```bash
git clone https://github.com/CuiBenyong/agent-engineering-labs.git
cd agent-engineering-labs/labs/my-coding-agent-21days/day-01-repl-skeleton/solution

pnpm install --ignore-workspace --config.strict-dep-builds=false
MOCK=1 pnpm start
```

Both flags are there for a reason:

- **`--ignore-workspace`** — each lab has its own `package.json`; without this, pnpm walks up looking for a workspace config and installs the wrong thing.
- **`--config.strict-dep-builds=false`** — as of pnpm 11, `strictDepBuilds` defaults to true, so ignoring the build script of `esbuild` (a transitive dependency of `tsx`) is promoted from a warning to a **fatal error** and install exits non-zero. This flag puts it back to a warning. On pnpm 10 or earlier it isn't needed, and passing it anyway is harmless.

(Each lab's `.npmrc` also carries `verify-deps-before-run=false` — the other half of the same problem: `pnpm start` re-runs an install check beforehand, and without disabling it the lab won't start even once the dependencies are in place.)

Every lab in [INDEX.en.md](./INDEX.en.md) is tagged with its type. The ones tagged **doc** have no `package.json`; just read the Markdown under `solution/`.

## Why everything runs offline

**`MOCK=1` is the single switch across every lab.** With it set, model calls are served from a local script: no network, no spend, identical output every time.

This isn't a cost-saving compromise; it's deliberate:

- **Reproducibility.** A real model answers differently every time, and a teaching lab whose result changes on every run can't be checked against an expected outcome.
- **Nobody stalls at step one.** Learning how agents work shouldn't start with "where do I get a key and how do I add credit."
- **It makes mutation testing possible.** With a fixed script you can switch a defense off and confirm the metric actually degrades — several courses use exactly this to prove a defense really works rather than passing by luck.

To run against a real model, fill in `.env` (every lab ships a `.env.example`) and drop `MOCK=1`.

## What a lab looks like

```
day-01-repl-skeleton/
├── README.md      # what to build, how it's checked, manual verification list
├── starter/       # skeleton with TODOs; tests are red
└── solution/      # reference implementation; tests are green
```

**Work in `starter/` first and only open `solution/` when you're stuck.** Reading the answer teaches you nothing — the value of these labs is precisely in the minutes you spend stuck.

Some labs ship a `docker-compose.yml` (the ones needing Postgres or Redis). Host ports are offset by day number, so several labs can run at once without colliding.

## The code shows *what*; the chapters explain *why*

This repo is only code. Why each lab is designed the way it is, where the traps are, and which approaches were tried and abandoned — that lives in the course chapters. [INDEX.en.md](./INDEX.en.md) links every lab to its chapter.

A few concrete examples of things the code alone won't tell you:

- Why merging `tool_calls` deltas requires a dictionary keyed by `index` rather than pushing onto an array (measured: the same model returned different starting indices on two runs the same day)
- Why any security defense that reports only ASR is untrustworthy (an agent that does nothing has an ASR of 0)
- Why "one setState per delta" produces no render storm under a local mock (React 18 automatic batching — measured: 174 deltas caused 6 renders)

## Index

[INDEX.en.md](./INDEX.en.md) — all 129 labs grouped by course, each linked to its chapter.

| Course | Labs |
|---|---|
| [From Frontend Engineer to Agent Engineer in 30 Days](https://course.front-end-js.top/en/learn/agent-30days) | 27 |
| [Build Your Own Coding Agent in 21 Days](https://course.front-end-js.top/en/learn/my-coding-agent-21days) | 21 |
| [RAG in 14 Days](https://course.front-end-js.top/en/learn/rag-14days) | 14 |
| [An AI Short-Drama Production Pipeline in 14 Days](https://course.front-end-js.top/en/learn/ai-drama-pipeline) | 14 |
| [MCP in 7 Days](https://course.front-end-js.top/en/learn/mcp-7days) | 7 |
| [Agent Skills in 7 Days](https://course.front-end-js.top/en/learn/agent-skills-7days) | 7 |
| [Frontend Agent UX in 7 Days](https://course.front-end-js.top/en/learn/frontend-agent-ux-7days) | 7 |
| [Agent Evals and Observability in 7 Days](https://course.front-end-js.top/en/learn/agent-evals-7days) | 7 |
| [Prompt Engineering From Scratch in 5 Days](https://course.front-end-js.top/en/learn/prompt-engineering-5days) | 5 |
| [Mastering Claude](https://course.front-end-js.top/en/learn/claude-mastery) | 5 |
| [Mastering Codex and the OpenAI Agents SDK](https://course.front-end-js.top/en/learn/codex-mastery) | 5 |
| [Context Engineering in 5 Days](https://course.front-end-js.top/en/learn/context-engineering-5days) | 5 |
| [Agent Security in 5 Days](https://course.front-end-js.top/en/learn/agent-security-5days) | 5 |

## Stack

Mostly TypeScript on Node 22. **No agent framework, on purpose** — the tool loop, SSE parsing, the MCP protocol and the event-stream rendering are all hand-written, because an agent's real complexity sits exactly in the layers a framework hides. A few labs use Next.js (the frontend UX course), Postgres/pgvector (RAG), or ffmpeg (the short-drama pipeline).

## Feedback

If a lab won't run, a README is unclear, or you find a bug, open an issue.

Code is [MIT](./LICENSE). The course prose is not covered by this license.

Related: [AI Agent Engineering Roadmap](https://github.com/CuiBenyong/agent-engineering-roadmap) — what order to take these courses in.
