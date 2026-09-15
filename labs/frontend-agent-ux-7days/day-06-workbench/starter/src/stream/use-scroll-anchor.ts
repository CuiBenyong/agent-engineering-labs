'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * 滚动锚定：贴底时跟随新内容，用户上翻时不动。
 *
 * 最常见的错误写法是每次内容变化就无条件 scrollToBottom()。
 * 后果是用户想往回看一句话，刚翻上去就被拽回底部，完全没法读。
 *
 * 正确的规则只有一条：**跟随与否取决于用户当前在不在底部**，
 * 而不是取决于有没有新内容。
 */

/** 距底多少像素之内算「贴底」。留一点余量，因为行高与缩放会让判断不精确。 */
const BOTTOM_THRESHOLD_PX = 48

export function useScrollAnchor<T extends HTMLElement>() {
  const ref = useRef<T | null>(null)
  const [pinned, setPinned] = useState(true)

  // 用 ref 存一份，避免在滚动回调里因为闭包拿到旧的 pinned。
  const pinnedRef = useRef(true)
  pinnedRef.current = pinned

  const handleScroll = useCallback(() => {
    const el = ref.current
    if (!el) return
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    setPinned(distance <= BOTTOM_THRESHOLD_PX)
  }, [])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.addEventListener('scroll', handleScroll, { passive: true })
    return () => el.removeEventListener('scroll', handleScroll)
  }, [handleScroll])

  /**
   * 内容更新后调用。只有在用户贴底时才跟随。
   *
   * 用 'auto' 而不是 'smooth'：流式期间每帧都可能调一次，
   * 平滑滚动会互相打断，看起来像卡顿。
   */
  const followIfPinned = useCallback(() => {
    if (!pinnedRef.current) return
    const el = ref.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [])

  const scrollToBottom = useCallback(() => {
    const el = ref.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    setPinned(true)
  }, [])

  return { ref, pinned, followIfPinned, scrollToBottom }
}
