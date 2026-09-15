/**
 * 一个会报进度的演示任务。本天新增，随实验分发，**离线可跑、零依赖**。
 *
 * 它假装在做一件要花点时间的活（装依赖、跑测试、打包），每做完一步就往
 * http://127.0.0.1:<MCA_TASK_PORT>/progress 报一次。两个环境变量都由 TaskManager
 * 在 spawn 的时候注入：MCA_TASK_ID 是它自己的任务号，MCA_TASK_PORT 是接收端端口。
 *
 * 报进度**失败不算失败**：接收端没起来（端口被占）的时候，这个任务照样应该把活干完。
 * 一个因为「报不上进度」就死掉的任务，比不报进度糟得多。
 */
const port = process.env.MCA_TASK_PORT ?? '3118'
const id = process.env.MCA_TASK_ID ?? 'unknown'
const steps = ['准备工作区', '跑一遍完整测试', '打包产物']
const stepMs = Number(process.env.MCA_WORKER_STEP_MS ?? 120)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

for (const [index, note] of steps.entries()) {
  await sleep(stepMs)
  console.log(`[${index + 1}/${steps.length}] ${note}`)
  try {
    await fetch(`http://127.0.0.1:${port}/progress`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task: id, step: index + 1, total: steps.length, note }),
    })
  } catch {
    console.log('（进度报不上去，接收端可能没起来；活照干）')
  }
}

console.log('全部做完')
