/**
 * ask_user 工具：让模型结构化地反问一句。本天新增。
 *
 * 两个实现决定值得说：
 *
 * 一、**readOnly 为真。** 它不改任何文件，所以第五天那个门直接放它过去。
 *    如果把提问也做成要审批的操作，就会出现「为了问一句话先问一句话」的荒唐链路。
 *
 * 二、**提问渠道靠闭包注入，不改 ToolContext。** 内核的 ToolContext 是冻结的三件套
 *    （cwd、signal、log），为一个工具往协议层加字段是最贵的一种做法——二十一天里
 *    每个 lab 的那份 types.ts 都得跟着改。这里改成「工具由一个工厂函数造出来，
 *    渠道在造它的时候闭进去」：REPL 造出来的那个从行队列读，自检造出来的那个按剧本答。
 *    **需要外部能力的工具都该这么做**，D15 的 MCP 工具、D18 的钩子都会照这个形状。
 */
import type { ToolDef, ToolResult } from '../kernel/types.js'
import {
  formatQuestion,
  normalizeQuestion,
  parseAnswer,
  type Answer,
  type Question,
} from './question.js'

/** 提问渠道：把问题摆给用户，拿回他打的那一行（输入结束时是 null） */
export type Asker = (question: Question) => Promise<string | null>

export interface AskOptions {
  ask?: Asker
  /** 提问与回答都要留一份在终端上，否则事后看不出这一轮为什么改了主意 */
  log?: (line: string) => void
}

/** 本会话里问过的问题与拿到的答案，给 /plan 与自检看 */
export interface AskRecord {
  question: string
  answer: Answer
}

export function createAskTool(options: AskOptions, records: AskRecord[] = []): ToolDef {
  return {
    name: 'ask_user',
    description:
      '在动手之前向用户问清一件事。只在「两种合理读法会导致完全不同的改动」时才用它，' +
      '能自己读代码查明的事不要问。' +
      '尽量给 options：把有哪几种做法先想清楚，用户才回答得快。' +
      'default 是用户直接回车时选的那一项，必须是 options 里的某个 value。',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '一句话的问题，不要一次问两件事' },
        options: {
          type: 'array',
          description: '可选项，每项是 value（回灌给你的短值）与 label（给人看的说明）',
          items: { type: 'object', required: ['value', 'label'] },
        },
        default: { type: 'string', description: '直接回车时选的 value' },
        multi: { type: 'boolean', description: '允许多选' },
      },
      required: ['question'],
      additionalProperties: false,
    },
    readOnly: true,

    async run(rawArgs: unknown): Promise<ToolResult> {
      const question = normalizeQuestion(rawArgs)
      if (!question) {
        return {
          ok: false,
          content: 'question 是空的，没有向用户提问。请把要问的那句话写进 question。',
        }
      }

      // 没有提问渠道时不许瞎猜也不许假装问过：明确回灌「这里问不了人」，
      // 让模型自己决定是按默认做法继续，还是停下来说明它需要一个决定。
      // 这条和第五天审批门的口径是同一条——无人值守时不许自动同意。
      if (!options.ask) {
        return {
          ok: false,
          content:
            `当前环境无法向用户提问（非交互终端），这个问题没有问出去：${question.question}。` +
            '请按最稳妥的一种做法继续，并在回答里说明你替用户做了哪个假设。',
        }
      }

      for (const line of formatQuestion(question)) options.log?.(line)
      const answer = parseAnswer(await options.ask(question), question)
      records.push({ question: question.question, answer })
      options.log?.(`（${answer.note}）`)

      if (answer.answers.length === 0) {
        return {
          ok: true,
          content: `用户没有回答「${question.question}」。请按最稳妥的一种做法继续并说明假设。`,
        }
      }
      return {
        ok: true,
        content: `用户对「${question.question}」的回答是：${answer.answers.join('、')}`,
        meta: { question: question.question, answers: answer.answers },
      }
    },
  }
}
