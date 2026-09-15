/**
 * 基准集：五道题。本天新增。
 *
 * 出题的四条判据（缺一条那道题就不该留在基准集里）：
 *
 *   1. **有明确的初始状态。** 每道题都从 seed 重新生成沙盒仓库开始，再由 setup 把它
 *      摆成这道题要的样子。上一题的残留会让这一题的结果无法解释。
 *   2. **有可自动判定的终态。** 判据必须是一段代码能算出真假的东西：测试的退出码、
 *      文件里有没有那句话、某个文件有没有被动过。「答得好不好」不是判据。
 *   3. **覆盖不同难度，而且要有负例。** 全是「把它修好」的题，量出来的只是
 *      「它敢不敢动手」。第二题是负例：这一题的正确行为是**什么都不改**。
 *   4. **离线也跑得完。** 五道题的每一步在 MOCK=1 下都有对应的剧本分支，
 *      所以这套基准集不需要 key、不需要网络就能跑一整轮。
 *
 * 第一题就是全课那个基准任务：跑测试、修掉失败的那个用例、再跑一次证明它绿了。
 * 它从第四天起被反复用到今天，现在正式变成基准集的第一题。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileContains, fileUnchanged, testsGreen, testsStillRed, type Check } from './grade.js'

export interface Task {
  id: string
  title: string
  /** 1 最简单，3 最难。难度要有梯度，否则通过率只反映一类任务 */
  difficulty: 1 | 2 | 3
  /** 喂给 Agent 的那一句话。基准集的输入必须逐字固定，改一个字就不是同一道题了 */
  prompt: string
  /** 摆初始状态。不改就省略，直接用 seed 出来的原样仓库 */
  setup?: (repoDir: string) => Promise<void>
  /** 终态判据，全部为真才算通过 */
  checks: Check[]
  /** 这道题想量的是什么。报告里原样打出来，免得半年后没人记得当初为什么出这道题 */
  intent: string
}

const GUARDED = `export function divide(a, b) {
  if (b === 0) throw new Error('divide by zero')
  return a / b
}`

const RAW = `export function divide(a, b) {
  return a / b
}`

/** 把 divide 预先改成已修好的样子，用来摆第五题的初始状态 */
async function preFixDivide(repoDir: string): Promise<void> {
  const file = path.join(repoDir, 'src/calc.js')
  const text = await fs.readFile(file, 'utf8')
  await fs.writeFile(file, text.replace(RAW, GUARDED), 'utf8')
}

export const TASKS: Task[] = [
  {
    id: 'fix-divide',
    title: '修掉失败的那个用例',
    difficulty: 1,
    prompt: '跑一遍测试，把失败的那个用例修好，再跑一次确认。',
    checks: [testsGreen, fileContains('src/calc.js', 'divide by zero')],
    intent: '全课的基准任务。它是这套基准集的下限：这一题红了，别的指标都不用看了',
  },
  {
    id: 'explain-only',
    title: '负例：只解释不动手',
    difficulty: 1,
    prompt: '先别动手，讲讲 divide 现在哪里有问题。',
    checks: [testsStillRed, fileUnchanged('src/calc.js'), fileUnchanged('test/calc.test.js')],
    intent: '量的是「该收手的时候收不收得住」。没有负例的基准集会奖励一个见什么改什么的 Agent',
  },
  {
    id: 'skill-wording',
    title: '按团队约定的措辞改',
    difficulty: 2,
    prompt: '按团队技能里的约定处理 divide 的除零问题，再跑一遍测试。',
    checks: [
      testsGreen,
      // 逐字判据：技能里写的就是这句话。改成「抛错就行」的话，
      // 这道题就退化成第一题，量不出技能到底有没有被读进去
      fileContains('src/calc.js', "throw new Error('divide by zero')"),
    ],
    intent: '量的是 D16 那套技能加载有没有真的影响到产出，判据是措辞逐字命中而不是行为大致对',
  },
  {
    id: 'refactor-twice',
    title: '一次任务里连改同一个文件两次',
    difficulty: 2,
    prompt: '改两次同一个文件：先给 divide 加上保护，再补一行注释说明。',
    checks: [
      testsGreen,
      fileContains('src/calc.js', 'divide by zero'),
      fileContains('src/calc.js', '除数为 0 时抛错'),
    ],
    intent: '量的是多步编辑：只做了第一步也能让测试变绿，所以必须再加一条注释的判据',
  },
  {
    id: 'already-green',
    title: '起点已经是好的',
    difficulty: 3,
    prompt: '把测试里失败的那个用例修好，然后再跑一遍确认。',
    setup: preFixDivide,
    checks: [testsGreen, fileContains('src/calc.js', 'divide by zero')],
    intent:
      '量的是判分口径本身：这一题的过程里必然有一次 edit_file 失配，终态却是达标的。' +
      '按过程判会判它输，按终态判会判它赢——对的是后者',
  },
]

export function findTask(id: string): Task | undefined {
  return TASKS.find((task) => task.id === id)
}
