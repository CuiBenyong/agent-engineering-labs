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
    // 【练习 4】判断用户此刻在不在底部，更新 pinned。
    //
    // 距底距离 = scrollHeight - scrollTop - clientHeight
    // 小于等于 BOTTOM_THRESHOLD_PX 就算贴底。
    // TODO
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
    // 【练习 5】只有用户贴底时才跟随到底部。
    //
    // 注意用 pinnedRef 而不是 pinned：这个回调会被 effect 依赖，
    // 直接读 state 会拿到旧值。
    // 另外用 scrollTop 直接赋值，不要用平滑滚动——流式期间每帧都可能调一次，
    // 平滑滚动会互相打断，看起来反而像卡顿。
    // TODO
  }, [])

  const scrollToBottom = useCallback(() => {
    const el = ref.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    setPinned(true)
  }, [])

  return { ref, pinned, followIfPinned, scrollToBottom }
}
