/**
 * 判分器。本天新增，是整个基准集里最该想清楚的一块。
 *
 * 一条口径定死全文：**判分只看终态，不看过程。**
 *
 * 「终态」是这次任务跑完之后，沙盒仓库是什么样子：测试跑不跑得过、某个文件里有没有
 * 那句话、不该动的文件有没有被动过。「过程」是它说了什么、调了几次工具、
 * 中间有没有失败过。为什么不能看过程：
 *
 *   1. **过程有很多条路都对。** 先读再改、先跑测试再改、直接改，做完的结果一样。
 *      按过程判分等于把你写基准集那天想到的那一条路当成唯一正确答案，
 *      模型换一条更好的路反而扣分。
 *   2. **过程里的失败不等于任务失败。** 本实验第五题就是这样：起点已经修好了，
 *      模型的第一次 edit_file 必然失配、回来一条 ok 为 false，但它接着跑了测试、
 *      结果是绿的——任务确实达成了。看过程会判它输，看终态会判它赢，而对的是后者。
 *   3. **过程判分最容易退化成「模型嘴上说成功了就算成功」**，那是这一整天最危险的错误：
 *      它给出的通过率永远好看，因为模型几乎从不承认自己没做到。
 *
 * 还有一条同样重要：**判分器自己跑测试，不借用被测对象的 run_command 工具。**
 * 用被测对象的工具去判被测对象，工具层一有 bug（截断把失败摘要切掉了、
 * 超时被当成成功），判分会跟着一起错，而且错得看不出来。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

export interface GradeContext {
  repoDir: string
  /** 判分器自己跑出来的结果，不是模型说的 */
  testsPass: boolean
  testOutput: string
  /** 终态：跑完之后仓库里这个文件的内容；文件不存在就是 undefined */
  now(relative: string): string | undefined
  /** 初始状态：这一题的 setup 做完、Agent 还没动手之前的内容 */
  before(relative: string): string | undefined
}

export interface Check {
  label: string
  run(ctx: GradeContext): boolean
}

/**
 * 跑测试：判分器的主力判据。退出码 0 才算绿。
 *
 * TODO(1)：现在这个版本**什么都没跑，直接说通过**——于是通过率永远是 100%。
 * 这是判分器最常见也最致命的一种坏法：**恒真的判分器**。它不会报错、不会变红，
 * 只会让你误以为 Agent 很强。
 *
 * 请把下面那段真正的实现放出来：spawn 一个 node --test，工作目录是 repoDir，
 * 退出码 0 才算绿，标准输出与错误输出都收起来（尾部两千字符就够），并且带超时。
 * 改完之后自检第二项会反向验证它不恒真：原样仓库必须是红的。
 */
export function runTests(
  repoDir: string,
  timeoutMs = 30_000
): Promise<{ pass: boolean; output: string }> {
  return Promise.resolve({ pass: true, output: '' })
  return new Promise((resolve) => {
    const child = spawn('node', ['--test'], { cwd: repoDir, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    const collect = (chunk: Buffer) => {
      output += chunk.toString('utf8')
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ pass: false, output: `判分器起不了测试进程：${String(error)}` })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ pass: code === 0, output: output.slice(-2000) })
    })
  })
}

export const testsGreen: Check = {
  label: '测试全绿',
  run: (ctx) => ctx.testsPass,
}

/** 负例用的反向判据：这一题本来就不该把测试修绿 */
export const testsStillRed: Check = {
  label: '测试仍然是红的（这一题不该动手修）',
  run: (ctx) => !ctx.testsPass,
}

export function fileContains(relative: string, needle: string): Check {
  return {
    label: `${relative} 里有「${needle}」`,
    run: (ctx) => (ctx.now(relative) ?? '').includes(needle),
  }
}

/**
 * 这个文件与初始状态**逐字节**一致。
 *
 * TODO(2)：现在它恒返回 true，所以负例那道题（「先别动手，只解释」）永远判通过，
 * 哪怕 Agent 把整个仓库翻了个底朝天。
 *
 * 请用 ctx.now 与 ctx.before 比一比。顺便想清楚为什么这条判据不能省：
 * 只断言「测试还是红的」是不够的——模型可能把测试文件删了、把 calc.js 改坏了，
 * 测试照样是红的，而那显然不是通过。
 */
export function fileUnchanged(relative: string): Check {
  return {
    label: `${relative} 一个字节都没被改动`,
    run: () => true,
  }
}

/** 把整个仓库读成一张「相对路径 → 内容」的表。快照与终态都用它 */
export async function readRepo(root: string): Promise<Map<string, string>> {
  const files = new Map<string, string>()
  const walk = async (dir: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else files.set(path.relative(root, full), await fs.readFile(full, 'utf8'))
    }
  }
  await walk(root)
  return files
}
