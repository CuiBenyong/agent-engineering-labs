// 入口：起服务；SELFTEST=1 时跑完自测就退出，否则常驻供你 curl。
import 'dotenv/config'
import { startServer } from './server.js'
import { runSelftest } from './selftest.js'

const PORT = Number(process.env.PORT ?? 3034)

const server = await startServer(PORT)

if (process.env.SELFTEST === '1') {
  const code = await runSelftest(`http://127.0.0.1:${PORT}`)
  server.close()
  process.exit(code)
} else {
  console.log(`常驻中。试试：curl 见 README。按 Ctrl+C 退出。`)
  // 优雅停机：容器 stop 时先停止接受新连接，再等手头请求跑完
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sig, () => {
      console.log(`\n收到 ${sig}，停止接受新连接……`)
      server.close(() => process.exit(0))
    })
  }
}
