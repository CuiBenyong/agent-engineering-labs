/**
 * 造出今天要用的三层指令文件。本天新增。
 *
 * 为什么要有这个文件：冻结的 seed.ts 只生成沙盒仓库，而今天的现象需要三层指令
 * 同时存在（其中两层还要互相覆盖）。所以指令文件由本文件单独造，**必须在 seedRepo 之后跑**
 * —— seedRepo 会先把 work/repo 整个删掉重建。
 *
 * 三层里最需要小心的是用户级：它落在 MCA_HOME 里（默认 work/home），
 * **一个字节都不会写到真实的用户主目录**。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { INSTRUCTION_FILE } from './discover.js'
import { instructionSources } from './index.js'

/** 用户级：我这个人的偏好，进任何仓库都生效。故意和项目级在「测试命令」上冲突 */
const USER = `# 我的个人偏好

- 回答语言：中文
- 测试命令：npm test

不要复述我的问题，直接给结论。
`

/** 项目级：这个仓库的规矩。它把细则拆到了 .mca/ 下面，用 @import 拉进来 */
const PROJECT = `# calc-demo 的规矩

- 测试命令：node --test
- 代码风格：不写分号，两个空格缩进

@import ./.mca/testing.md

改 src/ 下的文件之前先跑一次测试，确认当前确实是红的。
`

const TESTING = `- 失败用例：先看断言消息，再看堆栈

@import ./assert.md
`

const ASSERT = `- 断言库：只用 node:assert/strict
`

/** 目录级：这一片代码的特殊规矩。它是最具体的一层，所以「测试命令」由它说了算 */
const DIR = `# src/ 的特殊规矩

- 测试命令：node --test test/calc.test.js
- 除零处理：divide 遇到 0 必须抛错，不能安静地返回 Infinity

这一层的文件改完，立刻跑一次上面那条测试命令。
`

/** 两个坏例子，专门用来看错误提示。它们不在三层里，不会进 system prompt */
const CYCLE_A = `- 甲：这一条会生效

@import ./cycle-b.md
`
const CYCLE_B = `- 乙：这一条也会生效

@import ./cycle-a.md
`

export interface SeededInstructions {
  /** 写出的文件，按发现顺序 */
  files: string[]
  /** 坏例子所在的目录 */
  badDir: string
  /** 一个「AGENTS.md 是软链接、指向项目级那一份」的假主目录，用来验去重 */
  linkedHome: string
}

/**
 * force 为假时**不覆盖已存在的文件**。理由：读者会去手改这几份指令看效果，
 * 每次启动都覆盖一遍，等于他改什么都没用。自检里传 force 以保证起点一致。
 */
export async function seedInstructions(force = false): Promise<SeededInstructions> {
  const { home, start } = instructionSources()
  const repo = path.resolve(start, '..')
  const badDir = path.resolve(process.cwd(), 'work/instr-bad')

  const written: Array<[string, string]> = [
    [path.join(home, INSTRUCTION_FILE), USER],
    [path.join(repo, INSTRUCTION_FILE), PROJECT],
    [path.join(repo, '.mca/testing.md'), TESTING],
    [path.join(repo, '.mca/assert.md'), ASSERT],
    [path.join(start, INSTRUCTION_FILE), DIR],
    [path.join(badDir, 'cycle-a.md'), CYCLE_A],
    [path.join(badDir, 'cycle-b.md'), CYCLE_B],
    // 五层链：deep-1 是入口（第 0 层），往下每个文件一层。第 4 层超过深度上限 3
    [path.join(badDir, 'deep-1.md'), '- 一：入口\n\n@import ./deep-2.md\n'],
    [path.join(badDir, 'deep-2.md'), '- 二：第一层导入\n\n@import ./deep-3.md\n'],
    [path.join(badDir, 'deep-3.md'), '- 三：第二层导入\n\n@import ./deep-4.md\n'],
    [path.join(badDir, 'deep-4.md'), '- 四：第三层导入，刚好在上限上\n\n@import ./deep-5.md\n'],
    [path.join(badDir, 'deep-5.md'), '- 五：第四层，不该被展开\n'],
    // 菱形：dup-1 同时导入 dup-2 与 dup-3，两者都导入 dup-4。这不是循环，是重复
    [path.join(badDir, 'dup-1.md'), '@import ./dup-2.md\n\n@import ./dup-3.md\n'],
    [path.join(badDir, 'dup-2.md'), '- 二：走左边\n\n@import ./dup-4.md\n'],
    [path.join(badDir, 'dup-3.md'), '- 三：走右边\n\n@import ./dup-4.md\n'],
    [path.join(badDir, 'dup-4.md'), '- 四：两边都想要我\n'],
    // 想跳出根去读别的东西
    [
      path.join(badDir, 'escape.md'),
      '- 越界：下一行想读根之外的文件\n\n@import ../../package.json\n',
    ],
  ]

  for (const [file, content] of written) {
    await fs.mkdir(path.dirname(file), { recursive: true })
    if (!force) {
      const already = await fs
        .stat(file)
        .then(() => true)
        .catch(() => false)
      if (already) continue
    }
    await fs.writeFile(file, content, 'utf8')
  }

  // 软链接：把项目级那一份链到一个假主目录下。不去重的话它会被当成两层各加载一次
  const linkedHome = path.resolve(process.cwd(), 'work/instr-linked-home')
  await fs.mkdir(linkedHome, { recursive: true })
  const link = path.join(linkedHome, INSTRUCTION_FILE)
  await fs.rm(link, { force: true })
  await fs.symlink(path.join(repo, INSTRUCTION_FILE), link)

  return { files: written.map(([file]) => file), badDir, linkedHome }
}
