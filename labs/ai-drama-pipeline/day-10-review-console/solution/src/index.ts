// D10 实验（solution）：常驻的审核台。
//   MOCK=1 SELFTEST=1 pnpm start   自己跑一遍完整流程、打勾叉、按结果退出（验收入口）
//   MOCK=1 pnpm start              常驻，浏览器打开 http://localhost:3080 手动审片

import 'dotenv/config'
import { ensureFfmpeg } from './ffmpeg.js'
import { createProviders, isMock } from './providers/index.js'
import { warnIfPaidOutputInRepo, Run, newRunId } from './run.js'
import { ReviewStore } from './store.js'
import { countCalls, type CallCounter } from './fixtures.js'
import { PORT, createReviewServer } from './server.js'
import { selftest } from './selftest.js'

async function main() {
  warnIfPaidOutputInRepo()
  await ensureFfmpeg()

  const run = new Run(newRunId())
  await run.init()
  const calls: CallCounter = { text: 0, image: 0, video: 0, tts: 0 }
  const store = new ReviewStore(run, countCalls(createProviders(), calls))

  console.log(`模式：${isMock() ? 'MOCK 离线占位' : '真实厂商'}`)
  console.log('正在生成第一版素材（三镜：首帧 + 视频 + 配音）…')
  await store.seed()
  console.log(`产物目录：${run.dir}`)

  const server = createReviewServer(store)
  await new Promise<void>((resolve) => server.listen(PORT, resolve))
  console.log(`审核台已启动：http://localhost:${PORT}`)

  if (process.env.SELFTEST !== '1') {
    console.log('改台词只登记草稿，点「重生成受影响节点」才会真的调接口。Ctrl+C 退出。')
    return
  }

  const passed = await selftest(store, calls)
  server.close()
  if (!passed) process.exitCode = 1
}

main().catch((err: unknown) => {
  console.error(`\n失败：${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
})
