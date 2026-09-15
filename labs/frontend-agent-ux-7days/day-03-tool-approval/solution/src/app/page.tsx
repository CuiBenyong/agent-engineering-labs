import { Chat } from '@/components/chat'

export default function Page() {
  return (
    <main>
      <h1>D3：工具调用可视化与人在回路</h1>
      <p className="lede">
        选「危险工具」发送，运行会在工具执行前中断并等你确认。注意看：
        这不是前端弹了个框拦住请求，而是这一次运行真的结束了，你的决定会随下一次请求发回服务端。
      </p>
      <Chat />
    </main>
  )
}
