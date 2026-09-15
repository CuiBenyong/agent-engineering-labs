/**
 * 让模型自己维护清单的那个工具。本天新增。
 *
 * 三个设计决定：
 *
 * 一、**一个工具，两种写法。** `items` 传整张表就是整表替换，`id` + `status`
 *    就是单项更新。不做成两个工具，是因为它们操作同一份状态，而模型面对两个
 *    名字相近的工具时会挑错——把「第二条做完了」写成一次整表替换是很常见的错。
 *
 * 二、**readOnly 是真的。** 这个工具不动用户的任何文件，所以它不该触发第五天的
 *    审批门。审批门管的是「会不会造成不可逆的外部影响」，而清单是 Agent 自己的
 *    记事本——每改一条状态都要用户按一次 y，门就成了噪音，用户会一路按同意，
 *    等于把真正需要审批的写操作也放过去了。**门的价值取决于它多久响一次。**
 *
 * 三、**违规回灌，不抛异常。** 一次只允许一个进行中这条不变量被违反时，
 *    清单一个字都不改，把「你给了几个、分别是哪几条、请怎么改」当成一条
 *    ok 为 false 的工具结果回灌回去。这和第三天的坏参数、第五天的被拒绝、
 *    第六天的打转打断走的是同一条通路——模型已经很熟悉「失败结果就是下一步说明书」。
 */
import type { ToolContext, ToolDef, ToolResult } from '../kernel/types.js'
import { isTodoStatus, TODO_STATUSES, type TodoList, type TodoStatus } from './list.js'

export interface TodoToolOptions {
  /** 清单变了就叫一声，终端好重画那块固定区域 */
  onChange?: () => void
}

export function createTodoTool(list: TodoList, options: TodoToolOptions = {}): ToolDef {
  return {
    name: 'update_todos',
    description:
      '维护你自己的任务清单。三步以上的任务在动手之前先用它把计划写下来，' +
      '每做完一步就更新状态。两种写法：传 items 是整表替换（重新规划时用），' +
      '传 id 与 status 是只改一条（做完一步时用，更省）。' +
      '状态只有 pending、in_progress、done 三种，而且**同时只能有一个 in_progress**。',
    parameters: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          description: '整表替换：按顺序给出全部任务。会覆盖现有清单',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: '可选；不给就按顺序自动编号' },
              text: { type: 'string', description: '一句话说清这一步要做什么' },
              status: { type: 'string', enum: [...TODO_STATUSES] },
            },
            required: ['text', 'status'],
            additionalProperties: false,
          },
        },
        id: { type: 'string', description: '单项更新：要改的任务 id' },
        status: { type: 'string', enum: [...TODO_STATUSES], description: '单项更新：改成什么状态' },
      },
      additionalProperties: false,
    },
    // 见文件头第二条：清单不动用户的文件，不该惊动审批门
    readOnly: true,

    async run(rawArgs: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const args = (rawArgs ?? {}) as Record<string, unknown>

      if (Array.isArray(args.items)) {
        const parsed = parseItems(args.items)
        if ('error' in parsed) return { ok: false, content: parsed.error }
        const write = list.replace(parsed.items)
        options.onChange?.()
        return {
          ok: write.ok,
          content: write.ok ? `清单已更新（改动 ${write.changed} 项）：${write.note}` : write.note,
          meta: { revision: list.revision, changed: write.changed },
        }
      }

      if (typeof args.id === 'string') {
        if (!isTodoStatus(args.status)) {
          return { ok: false, content: statusError(args.status) }
        }
        const write = list.setStatus(args.id, args.status)
        options.onChange?.()
        return {
          ok: write.ok,
          content: write.note,
          meta: { revision: list.revision, changed: write.changed },
        }
      }

      return {
        ok: false,
        content:
          '这次调用既没给 items（整表替换）也没给 id 加 status（单项更新），什么都没做。' +
          '重新规划请传 items，只改一条请传 id 与 status。',
      }
    },
  }
}

function parseItems(
  raw: unknown[]
): { items: Array<{ id?: string; text: string; status: TodoStatus }> } | { error: string } {
  const items: Array<{ id?: string; text: string; status: TodoStatus }> = []
  for (const [i, entry] of raw.entries()) {
    if (typeof entry !== 'object' || entry === null) {
      return { error: `items 的第 ${i + 1} 项不是对象，清单没有被改动。` }
    }
    const bag = entry as Record<string, unknown>
    const text = typeof bag.text === 'string' ? bag.text.trim() : ''
    if (!text) return { error: `items 的第 ${i + 1} 项缺少 text，清单没有被改动。` }
    if (!isTodoStatus(bag.status)) return { error: statusError(bag.status, i + 1) }
    items.push({
      ...(typeof bag.id === 'string' ? { id: bag.id } : {}),
      text,
      status: bag.status,
    })
  }
  if (items.length === 0) return { error: 'items 是空数组。要清空清单请让用户用 /todos clear。' }
  return { items }
}

/** 状态写错时的纠正。把三个合法值原样列出来，模型下一轮就改对了 */
function statusError(got: unknown, index?: number): string {
  const where = index === undefined ? '' : `第 ${index} 项的`
  return (
    `${where}status 是「${String(got)}」，不是合法状态。只有三种：${TODO_STATUSES.join('、')}。` +
    '清单没有被改动。'
  )
}
