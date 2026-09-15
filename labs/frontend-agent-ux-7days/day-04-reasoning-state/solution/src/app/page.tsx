import { Chat } from '@/components/chat'

export default function Page() {
  return (
    <main>
      <h1>D4：推理过程与共享状态</h1>
      <p className="lede">
        默认剧本会先流式吐一段推理（默认收起），再用快照打底、增量补丁更新右侧的共享状态面板。
        选「补丁打不上」看界面怎么发现不一致并恢复。
      </p>
      <Chat />
    </main>
  )
}
