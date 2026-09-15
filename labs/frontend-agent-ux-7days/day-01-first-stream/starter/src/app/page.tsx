import { Chat } from '@/components/chat'

export default function Page() {
  return (
    <main>
      <h1>D1：浏览器里的第一条流</h1>
      <p className="lede">
        这一版刻意用最直白的写法：每收到一个增量就更新一次状态。把「burst（风暴）」选上再发送，
        就能看到 D2 要解决的问题。
      </p>
      <Chat />
    </main>
  )
}
