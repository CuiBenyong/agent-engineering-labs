import type { Config } from 'drizzle-kit'

// drizzle-kit generate 读这份配置：比对 schema 与 drizzle/ 下已有的迁移，产出下一个序号的 SQL
export default {
  schema: './src/shared/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
} satisfies Config
