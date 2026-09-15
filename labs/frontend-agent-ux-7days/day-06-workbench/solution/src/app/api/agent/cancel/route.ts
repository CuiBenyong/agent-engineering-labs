export const dynamic = 'force-dynamic'

/**
 * 显式取消。
 *
 * 存在的理由：前端的 AbortController 只关闭自己这一侧的连接，
 * 服务端的运行还在跑、token 还在烧。真要停下来需要这个请求。
 *
 * 真实实现里这里会去查一张运行表并给那个运行打上取消标记，
 * 由运行循环在下一步检查时退出。本课是离线剧本，记一笔日志即可。
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { runId?: string }
  if (process.env.NODE_ENV !== 'production') {
    console.log('[agent] 收到取消请求', body.runId)
  }
  return Response.json({ cancelled: true, runId: body.runId ?? null })
}
