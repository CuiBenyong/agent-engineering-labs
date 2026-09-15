import { Chat } from '@/components/chat'

export default function Page() {
  return (
    <main>
      <h1>D5：生成式界面的三种范式</h1>
      <p className="lede">
        默认剧本演示静态生成式（模型从注册表里挑组件）与声明式（模型给一棵界面描述树）。
        选「未注册组件」看兜底：一个块渲染失败不应该影响其余内容。
      </p>
      <Chat />
    </main>
  )
}
