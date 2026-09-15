import express from 'express'
import { router as todos } from './routes/todos.js'

export function createApp() {
  const app = express()
  app.use(express.json())
  app.use(todos)
  return app
}
