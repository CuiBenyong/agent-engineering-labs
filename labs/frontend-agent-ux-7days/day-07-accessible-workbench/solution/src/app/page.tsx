import { Chat } from '@/components/chat'

export default function Page() {
  return (
    <>
      {/* 跳转链接：键盘用户第一个 Tab 就能跳到主内容 */}
      <a className="skip-link" href="#main">
        跳到主内容
      </a>
      <main id="main">
        <h1>D7：可访问性与性能预算</h1>
        <p className="lede">
          流式内容的播报走「静默 + 按句分段」，不是把实时区域指向流式元素。
          打开屏幕阅读器发送一次，对比两种做法的差别。页面上方有性能预算面板。
        </p>
        <Chat />
      </main>
    </>
  )
}
