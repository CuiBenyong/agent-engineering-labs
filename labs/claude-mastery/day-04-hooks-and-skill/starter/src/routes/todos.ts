import { randomUUID } from 'node:crypto'
import { Router } from 'express'
import { z } from 'zod'
import { store } from '../store.js'

// 只声明客户端可以传的字段；id 与 done 不在 schema 里，.strict() 让多余字段直接判 400
const CreateTodo = z
  .object({
    title: z.string().trim().min(1).max(200),
    dueAt: z.string().datetime().optional(),
  })
  .strict()

export const router = Router()

router.get('/todos', (_req, res) => {
  res.json(store)
})

router.post('/todos', (req, res) => {
  const parsed = CreateTodo.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({
      error: 'invalid body',
      issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
    })
    return
  }
  const todo = { id: randomUUID(), done: false, ...parsed.data }
  store.push(todo)
  res.status(201).json(todo)
})
