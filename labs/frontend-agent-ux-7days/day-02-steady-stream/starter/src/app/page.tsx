import { Chat } from '@/components/chat'

export default function Page() {
  return (
    <main>
      <h1>D2：不抖的流式渲染</h1>
      <p className="lede">
        选「burst（风暴）」发送，然后开关「按帧合并」对照两次的统计数字。
        流跑起来的时候在输入框里打字，感受输入有没有被拖卡。
      </p>
      <Chat />
    </main>
  )
}
