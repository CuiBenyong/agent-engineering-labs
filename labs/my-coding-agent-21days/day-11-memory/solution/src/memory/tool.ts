/**
 * 让模型自己沉淀记忆的那个工具。本天新增，是两条写入路径里的第二条。
 *
 * 三个设计决定：
 *
 * 一、**要它自己给关键词与路径，而不是我们从正文里抽。**
 *    抽词的兜底实现在 `store.ts` 里（显式命令那一路要用），但模型知道得比它多：
 *    它刚读过那个文件，知道这条经验以后会在什么话题下用得上。
 *    **把「以后怎么找回来」交给写的时候想，比交给检索的时候猜便宜得多。**
 *
 * 二、**锚点是可选的，但描述里要主动求。** 锚点是这条记忆将来能被自动核对的唯一依据。
 *    有它，三个月后文件一改这条记忆就自己举手；没它，它会一直被当成新的。
 *
 * 三、**readOnly 是 false。** 和第十天的清单工具正好相反：清单是易失的工作面，
 *    记忆是**会留在磁盘上、并且会影响以后每一次会话**的东西。
 *    一个会改变将来所有会话行为的写操作，正是第五天那道审批门该管的东西。
 *    判据从来不是「它改的是不是用户的源码」，而是「它会不会造成不可逆的外部影响」。
 */
import type { ToolContext, ToolDef, ToolResult } from '../kernel/types.js'
import { MEMORY_TEXT_LIMIT, write } from './store.js'

export function createMemoryTool(): ToolDef {
  return {
    name: 'remember',
    description:
      '把一条以后还用得上的事实写进长期记忆，跨会话保留。' +
      '值得记的是读代码读不出来的东西：这个仓库的坑、口头约定、试过但不行的做法、用户的偏好。' +
      '不要记密钥或任何凭据，不要记「现在测试是红的」这类只在此刻成立的进展，' +
      '也不要记代码里已经写着的事（读一次文件就知道的不必记）。' +
      '一条记一件事，一句话说完。keys 给几个以后会用来找回它的词，' +
      'paths 给相关的文件路径，anchor 给一个「这条记忆还成不成立」的可核对依据。',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: `要记住的这一件事，一句话，最多 ${MEMORY_TEXT_LIMIT} 字符`,
        },
        keys: {
          type: 'array',
          items: { type: 'string' },
          description: '以后会用来找回它的几个词，2 到 6 个',
        },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: '相关的文件或目录路径，相对仓库根，可以为空',
        },
        anchor: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '核对时去读哪个文件' },
            contains: { type: 'string', description: '那个文件里应该还能找到的一段字' },
          },
          required: ['path', 'contains'],
          additionalProperties: false,
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
    // 见文件头第三条：它会留在磁盘上并影响以后每一次会话，该过审批门
    readOnly: false,

    async run(rawArgs: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const args = (rawArgs ?? {}) as Record<string, unknown>
      const text = typeof args.text === 'string' ? args.text.trim() : ''
      if (!text) return { ok: false, content: 'text 是空的，什么都没记。' }
      if (text.length > MEMORY_TEXT_LIMIT) {
        return {
          ok: false,
          content:
            `这条有 ${text.length} 字符，超过上限 ${MEMORY_TEXT_LIMIT}，没有记下来。` +
            '一条记忆只记一件事——太长说明它其实是几件事，请拆开分几次调用。',
        }
      }

      const anchor = parseAnchor(args.anchor)
      const outcome = await write({
        text,
        source: 'model',
        keys: stringList(args.keys),
        paths: stringList(args.paths),
        ...(anchor ? { anchor } : {}),
      })

      // 被拦下来时把理由原样回灌：它是模型的下一步说明书，
      // 而三类拦截各自都给了「该往哪儿放」。这条通路从第三天的坏参数起就没变过
      if (!outcome.ok) {
        return {
          ok: false,
          content: outcome.verdict.note,
          meta: { reason: outcome.verdict.reason },
        }
      }
      if (outcome.duplicateOf) {
        return {
          ok: true,
          content: `这条事实已经记过了（${outcome.duplicateOf}），没有新增文件。`,
          meta: { id: outcome.duplicateOf, duplicate: true },
        }
      }
      return {
        ok: true,
        content:
          `已记下 ${outcome.memory.id}：${outcome.memory.text}` +
          `（关键词 ${outcome.memory.keys.slice(0, 6).join('、') || '无'}` +
          `${outcome.memory.anchor ? `，锚点 ${outcome.memory.anchor.path}` : '，没有锚点'}）`,
        meta: { id: outcome.memory.id },
      }
    },
  }
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

function parseAnchor(value: unknown): { path: string; contains: string } | null {
  if (typeof value !== 'object' || value === null) return null
  const bag = value as Record<string, unknown>
  if (typeof bag.path !== 'string' || typeof bag.contains !== 'string') return null
  if (!bag.path.trim() || !bag.contains.trim()) return null
  return { path: bag.path.trim(), contains: bag.contains.trim() }
}
