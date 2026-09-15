// 一个 node:http 服务 + 五个 JSON 接口 + 一个静态页面。不引前端框架，
// 因为这一天要讲的是「人机协作的介入点与数据设计」，不是构建工具。

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { WORK_DIR } from './run.js'
import { PAGE } from './ui.js'
import type { ReviewStore } from './store.js'

export const PORT = Number(process.env.PORT ?? 3080)

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.json': 'application/json',
}

function send(
  res: ServerResponse,
  code: number,
  body: string | Buffer,
  type = 'application/json; charset=utf-8'
): void {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' })
  res.end(body)
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
}

/** 只允许读 work 目录里的文件。审核台会被内网同事打开，路径穿越必须挡住。 */
async function serveMedia(res: ServerResponse, rawPath: string): Promise<void> {
  const target = resolve(decodeURIComponent(rawPath))
  if (!target.startsWith(resolve(WORK_DIR)))
    return send(res, 403, JSON.stringify({ error: 'forbidden' }))
  try {
    const ext = target.slice(target.lastIndexOf('.'))
    send(res, 200, await readFile(target), MIME[ext] ?? 'application/octet-stream')
  } catch {
    send(res, 404, JSON.stringify({ error: 'not found' }))
  }
}

export function createReviewServer(store: ReviewStore) {
  return createServer((req, res) => {
    void handle(req, res, store).catch((err: unknown) =>
      send(res, 400, JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
    )
  })
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  store: ReviewStore
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)
  const path = url.pathname

  if (req.method === 'GET' && path === '/') return send(res, 200, PAGE, 'text/html; charset=utf-8')
  if (req.method === 'GET' && path === '/api/run')
    return send(res, 200, JSON.stringify(store.view()))
  if (req.method === 'GET' && path.startsWith('/media/'))
    return serveMedia(res, path.slice('/media/'.length))

  const m = /^\/api\/shots\/([\w-]+)\/(edit|regenerate|rollback|review)$/.exec(path)
  if (req.method === 'POST' && m) {
    const [, shotId, action] = m
    const body = await readJson(req)
    if (action === 'edit') {
      const field = body.field === 'visual' ? 'visual' : 'dialogue'
      const affected = store.edit(shotId, field, String(body.value ?? ''))
      return send(res, 200, JSON.stringify({ shotId, field, affected }))
    }
    if (action === 'regenerate')
      return send(res, 200, JSON.stringify(await store.regenerate(shotId)))
    if (action === 'rollback')
      return send(res, 200, JSON.stringify(await store.rollback(shotId, Number(body.version))))
    const verdict = body.verdict === 'redo' || body.verdict === 'hold' ? body.verdict : 'pass'
    const tags = Array.isArray(body.tags) ? body.tags.map(String) : []
    return send(
      res,
      200,
      JSON.stringify(
        await store.recordReview({ shotId, verdict, tags, comment: String(body.comment ?? '') })
      )
    )
  }

  send(res, 404, JSON.stringify({ error: 'no route' }))
}
