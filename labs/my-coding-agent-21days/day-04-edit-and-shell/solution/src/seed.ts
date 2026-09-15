/**
 * 生成练习用的沙盒仓库。★ D1 定稿，之后二十天逐字不变。
 *
 * 全课的基准任务只有一句话：「跑测试，修掉失败的那个用例，再跑一次证明它绿了」。
 * D4 第一次做到，D6 用它演示自纠，D7 演示恢复，D14 演示回滚，D20 当基准集第一题。
 *
 * 它零依赖：测试用 Node 自带的 node --test，所以沙盒仓库不需要 pnpm install。
 */
import fs from 'node:fs/promises'
import path from 'node:path'

export const REPO_DIR = path.resolve(process.cwd(), 'work/repo')

const FILES: Record<string, string> = {
  'package.json':
    JSON.stringify(
      { name: 'calc-demo', version: '0.0.0', type: 'module', scripts: { test: 'node --test' } },
      null,
      2
    ) + '\n',
  'src/calc.js': `export function add(a, b) {
  return a + b
}

export function subtract(a, b) {
  return a - b
}

// 这里就是那个 bug：除数为 0 时应该抛错，现在会安静地返回 Infinity
export function divide(a, b) {
  return a / b
}
`,
  'test/calc.test.js': `import assert from 'node:assert/strict'
import { test } from 'node:test'
import { add, subtract, divide } from '../src/calc.js'

test('add', () => {
  assert.equal(add(2, 3), 5)
})

test('subtract', () => {
  assert.equal(subtract(5, 3), 2)
})

test('divide', () => {
  assert.equal(divide(6, 3), 2)
})

test('divide by zero should throw', () => {
  assert.throws(() => divide(1, 0), /zero/)
})
`,
  'README.md': `# calc-demo

一个用来练习的最小仓库。跑 \`node --test\` 会有一个用例失败，那就是今天要修的东西。
`,
}

/** 重新生成沙盒仓库；返回写出的文件相对路径列表 */
export async function seedRepo(): Promise<string[]> {
  await fs.rm(REPO_DIR, { recursive: true, force: true })
  const written: string[] = []
  for (const [relative, content] of Object.entries(FILES)) {
    const target = path.join(REPO_DIR, relative)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, content, 'utf8')
    written.push(relative)
  }
  return written.sort()
}
