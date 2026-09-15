'use client'

import { memo } from 'react'
import {
  parseIncrementalMarkdown,
  parseInline,
  type InlineToken,
  type MarkdownBlock,
} from '@/stream/incremental-markdown'

function Inline({ text }: { text: string }) {
  const tokens = parseInline(text)
  return (
    <>
      {tokens.map((t: InlineToken, i: number) => {
        if (t.kind === 'code') return <code key={i}>{t.text}</code>
        if (t.kind === 'strong') return <strong key={i}>{t.text}</strong>
        return <span key={i}>{t.text}</span>
      })}
    </>
  )
}

function Block({ block }: { block: MarkdownBlock }) {
  switch (block.kind) {
    case 'code':
      return (
        <pre className={block.complete ? 'code complete' : 'code streaming'}>
          {block.language ? <span className="lang">{block.language}</span> : null}
          <code>{block.text}</code>
        </pre>
      )

    case 'heading': {
      // 正文里的标题统一降一级：聊天气泡里冒出一个 h1 会破坏页面的标题层级，
      // 对屏幕阅读器的大纲导航也是污染。
      const Tag = `h${Math.min(block.level + 2, 6)}` as 'h3'
      return (
        <Tag>
          <Inline text={block.text} />
        </Tag>
      )
    }

    case 'list': {
      const Tag = block.ordered ? 'ol' : 'ul'
      return (
        <Tag>
          {block.items.map((item, i) => (
            <li key={i}>
              <Inline text={item} />
            </li>
          ))}
        </Tag>
      )
    }

    default:
      return (
        <p>
          <Inline text={block.text} />
        </p>
      )
  }
}

/**
 * memo 很关键：一条已经写完的历史消息，不应该因为**另一条**消息在流式更新
 * 而重新渲染。没有这层，长会话里每一帧都会把全部历史重算一遍。
 */
export const StreamingMarkdown = memo(function StreamingMarkdown({ text }: { text: string }) {
  const blocks = parseIncrementalMarkdown(text)
  return (
    <div className="markdown">
      {blocks.map((block, i) => (
        <Block key={i} block={block} />
      ))}
    </div>
  )
})
