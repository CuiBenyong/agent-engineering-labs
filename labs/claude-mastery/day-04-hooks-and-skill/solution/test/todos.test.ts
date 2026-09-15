import type { Server } from 'node:http'
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { reset } from '../src/store.js'

let server: Server
let base: string

beforeAll(async () => {
  server = createApp().listen(0)
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  base = `http://127.0.0.1:${addr.port}`
})

afterAll(() => {
  server.close()
})

beforeEach(() => reset())

async function post(body: unknown) {
  return fetch(`${base}/todos`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

it('creates a todo', async () => {
  const res = await post({ title: 'buy milk' })
  expect(res.status).toBe(201)
  const json = (await res.json()) as { title: string; done: boolean }
  expect(json.title).toBe('buy milk')
  expect(json.done).toBe(false)
})

it('rejects an empty title', async () => {
  const res = await post({ title: '   ' })
  expect(res.status).toBe(400)
  const json = (await res.json()) as { error: string; issues: { path: string[] }[] }
  expect(json.error).toBe('invalid body')
  expect(json.issues[0]?.path).toEqual(['title'])
})

it('rejects an oversized title', async () => {
  const res = await post({ title: 'x'.repeat(201) })
  expect(res.status).toBe(400)
})

it('rejects an invalid dueAt', async () => {
  const res = await post({ title: 'ok', dueAt: 'tomorrow' })
  expect(res.status).toBe(400)
})

it('ignores a client-provided id', async () => {
  const res = await post({ title: 'ok', id: 'hacked' })
  // .strict() 让多余字段直接判 400，而不是静默忽略
  expect(res.status).toBe(400)
})
