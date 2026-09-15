import { Chat } from '@/components/chat'

export default function Page() {
  return (
    <main>
      <h1>D6：会话控制与长任务</h1>
      <p className="lede">
        输入内容发送，流式期间可以「停止」再「续播」——注意续播会重复收到几条事件，
        去重是前端的责任。已发送的每一轮都能编辑重发，旧分支不会丢，可以左右切换对比。
      </p>
      <Chat />
    </main>
  )
}
