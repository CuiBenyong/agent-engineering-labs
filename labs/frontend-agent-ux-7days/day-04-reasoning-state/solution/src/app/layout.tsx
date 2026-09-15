import type { ReactNode } from 'react'
import './globals.css'

export const metadata = {
  title: 'D1 第一条流',
  description: '用 fetch 加 ReadableStream 读一条 AG-UI 事件流',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  )
}
