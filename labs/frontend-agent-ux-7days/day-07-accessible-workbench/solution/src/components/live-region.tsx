'use client'

import { useEffect, useRef, useState } from 'react'

/**
 * 屏幕阅读器的实时区域。
 *
 * 三个必须做对的细节：
 *
 * 1. **这个元素本身不显示内容给视觉用户**。它只承载播报文本，
 *    用视觉隐藏（而不是 display:none）——后者会让屏幕阅读器也读不到。
 *
 * 2. **页面加载时必须是空的**。带着内容出现的实时区域不会被播报，
 *    规范要求区域先存在、内容后变化才会触发。
 *
 * 3. **polite 而不是 assertive**。assertive 会打断用户当前正在听的内容，
 *    对于 Agent 的回复这是不合适的——那是信息不是警报。
 *    真正需要 assertive 的只有错误与需要立即决定的审批。
 */
export function LiveRegion({ message, urgent = false }: { message: string; urgent?: boolean }) {
  return (
    <div
      className="visually-hidden"
      role={urgent ? 'alert' : 'status'}
      aria-live={urgent ? 'assertive' : 'polite'}
      // 关键：atomic 为 false，只播报新增的那一段，而不是整个区域重念。
      aria-atomic="false"
      data-testid={urgent ? 'live-region-urgent' : 'live-region'}
    >
      {message}
    </div>
  )
}

/**
 * 把一串待播报的句子按节奏喂给实时区域。
 *
 * 为什么要排队：连续两次改同一个区域的内容，屏幕阅读器很可能只念到最后一次。
 * 所以要留出间隔，让每一段都被念完。
 */
export function useAnnouncementQueue(intervalMs = 1200) {
  const [current, setCurrent] = useState('')
  const queue = useRef<string[]>([])
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    timer.current = setInterval(() => {
      const next = queue.current.shift()
      if (next !== undefined) setCurrent(next)
    }, intervalMs)
    return () => {
      if (timer.current) clearInterval(timer.current)
    }
  }, [intervalMs])

  return {
    current,
    push: (text: string) => {
      queue.current.push(text)
    },
    clear: () => {
      queue.current = []
      setCurrent('')
    },
  }
}
