/**
 * 配置分层。本天新增，是今天的主菜。
 *
 * 前二十天只有一层：环境变量（config.ts）。够用是因为只有一个用户、一个仓库、
 * 一个终端。装到别人机器上之后，同一个值会同时有四个人想说了算：
 *
 *   ① 命令行参数   这一次要不一样（--model 换个模型试一下）
 *   ② 环境变量     这个终端会话要不一样（CI 里、临时切网关）
 *   ③ 项目配置     这个仓库要不一样（团队约定，进 git，人人一致）
 *   ④ 用户配置     这台机器上我个人的默认（不进任何仓库）
 *   ⑤ 内置默认值   什么都没配时的兜底
 *
 * **优先级就是「作用范围越窄的越大」**，这条不是品味是推导：范围越窄，说明用户
 * 越明确地在说「就这一次/就这里」，越晚被写下、越针对当下。倒过来的任何一种排法
 * 都会造成同一种症状——用户加了个参数，结果没生效，而且没有任何报错。
 *
 * 两条配套决定，缺一条这套分层就不好用：
 *
 * **一、每个值都要记住它从哪来。** 配置分层最常见的故障不是「值错了」，
 * 是「我不知道这个值为什么是这样」。所以解析结果不是一个 { baseUrl, model }，
 * 而是每个键都带 source 与 from，`mca --config` 一打全摊开。
 *
 * **二、配置文件里不许放密钥。** 见下面 SECRET_KEYS 那一段。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { DEFAULT_BASE_URL, DEFAULT_MODEL } from '../config.js'
import { projectConfigDir, userConfigDir } from './paths.js'

/** 分层的名字，按优先级从低到高排。数组顺序就是覆盖顺序，不要另写一张优先级表 */
export const LAYERS = ['default', 'user', 'project', 'env', 'flag'] as const
export type Layer = (typeof LAYERS)[number]

/** 能被配置文件写的键。**apiKey 不在里面**，这是故意的 */
export interface FileConfig {
  baseUrl?: string
  model?: string
}

export interface Traced {
  value: string
  layer: Layer
  /** 人话来源：哪个文件、哪个环境变量、哪个参数 */
  from: string
}

export interface ShipConfig {
  baseUrl: Traced
  model: Traced
  /** 密钥永远不参与分层：它只能来自环境变量 */
  apiKey: string
  apiKeyFrom: string
  mock: boolean
  /** 读配置文件时发现的问题。一条都不能吞掉 */
  warnings: string[]
  /** 实际读到的文件（不存在的也列出来，好让用户知道该去哪儿建） */
  files: Array<{ layer: Layer; path: string; exists: boolean }>
}

/**
 * 绝不接受出现在配置文件里的键。
 *
 * 理由不是洁癖：项目配置是要**进 git** 的，用户配置是明文躺在家目录里的，
 * 两者都会被备份工具、同步盘、截屏、以及「你把配置发我看看」顺走。
 * 而环境变量的生命周期只有这个进程，`.env` 至少有一条人人都懂的规矩叫「别提交」。
 *
 * 做法是**读到就拒绝并警告**，不是读到就用。静默忽略同样不行：
 * 用户明明写了 key 却一直报「没有 key」，他会以为是工具坏了。
 */
// TODO(4) 这张表是空的，于是配置文件里写的 apiKey 会被原样收下。
//   补全它（想想还有哪些常见写法），并确认下面那段循环做的是「拒绝 + 警告」——
//   既不是静默忽略（用户会以为工具坏了），也不是照单全收（密钥会跟着配置进 git）。
const SECRET_KEYS: string[] = []

async function readLayerFile(
  file: string
): Promise<{ data: FileConfig; exists: boolean; warnings: string[] }> {
  let raw: string
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch {
    // 配置文件不存在是绝对正常的状态，不是错误：绝大多数用户一个都不会建
    return { data: {}, exists: false, warnings: [] }
  }
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>
  } catch (error) {
    // 坏掉的配置文件要说清是哪个文件坏了，并且继续用别的层——
    // 一个多打的逗号不该让整个工具起不来（和 D16 对坏技能包的处理是同一条）
    return {
      data: {},
      exists: true,
      warnings: [`${file} 不是合法 JSON（${(error as Error).message}），这一层已跳过`],
    }
  }
  const warnings: string[] = []
  for (const key of SECRET_KEYS) {
    if (key in parsed) {
      warnings.push(
        `${file} 里出现了 ${key}：配置文件不是放密钥的地方，这一项已被忽略。` +
          `密钥请放环境变量 LLM_API_KEY 或不进 git 的 .env`
      )
      delete parsed[key]
    }
  }
  const data: FileConfig = {}
  if (typeof parsed.baseUrl === 'string') data.baseUrl = parsed.baseUrl
  if (typeof parsed.model === 'string') data.model = parsed.model
  for (const key of Object.keys(parsed)) {
    if (key !== 'baseUrl' && key !== 'model') {
      // 不认识的键要说出来。静默忽略的代价是用户写错一个字母，
      // 然后花半小时想不通为什么配置没生效
      warnings.push(`${file} 里的 ${key} 不是 mca 认得的配置项，已忽略`)
    }
  }
  return { data, exists: true, warnings }
}

export interface FlagConfig {
  baseUrl?: string
  model?: string
}

/**
 * 把五层按顺序叠起来，并记住每个键最后一次被谁写的。
 *
 * 实现上只有一个要点：**后写的覆盖先写的，而且写的时候连来源一起写。**
 * 这样「优先级」就不再是一段 if-else，而是一次有序遍历——加一层只要往数组里
 * 插一个元素，不用重排任何判断。
 */
export interface ConfigDirs {
  /** 覆盖用户目录与项目目录。只给自检用：它要在临时目录里摆出四层再看谁赢 */
  userDir?: string
  projectDir?: string
}

export async function loadShipConfig(
  flags: FlagConfig = {},
  dirs: ConfigDirs = {}
): Promise<ShipConfig> {
  const userFile = path.join(dirs.userDir ?? userConfigDir(), 'config.json')
  const projectFile = path.join(dirs.projectDir ?? projectConfigDir(), 'config.json')
  const user = await readLayerFile(userFile)
  const project = await readLayerFile(projectFile)

  const env: FileConfig = {}
  if (process.env.LLM_BASE_URL) env.baseUrl = process.env.LLM_BASE_URL
  if (process.env.LLM_MODEL) env.model = process.env.LLM_MODEL

  // TODO(3) 这张表的**顺序就是覆盖顺序**：排在后面的盖排在前面的。
  //   现在它有两处不对：顺序反了，而且少了一层（命令行参数那一层根本没出现）。
  //   自检第 6、7 项会分别告诉你「谁赢了」和「来源记成了哪一层」。
  //   提示：优先级是「作用范围越窄的越大」，flags 是最窄的那一个。
  const stack: Array<{ layer: Layer; from: string; data: FileConfig }> = [
    { layer: 'env', from: '环境变量', data: env },
    { layer: 'project', from: projectFile, data: project.data },
    { layer: 'user', from: userFile, data: user.data },
    {
      layer: 'default',
      from: '内置默认值',
      data: { baseUrl: DEFAULT_BASE_URL, model: DEFAULT_MODEL },
    },
  ]

  const traced: Record<'baseUrl' | 'model', Traced> = {
    baseUrl: { value: DEFAULT_BASE_URL, layer: 'default', from: '内置默认值' },
    model: { value: DEFAULT_MODEL, layer: 'default', from: '内置默认值' },
  }
  for (const entry of stack) {
    for (const key of ['baseUrl', 'model'] as const) {
      const value = entry.data[key]
      if (value === undefined) continue
      const detail =
        entry.layer === 'env'
          ? `环境变量 ${key === 'model' ? 'LLM_MODEL' : 'LLM_BASE_URL'}`
          : entry.from
      traced[key] = { value, layer: entry.layer, from: detail }
    }
  }
  // 末尾斜杠在拼 URL 时会变成 //v1//chat，统一在这里抹掉（和 config.ts 同一条口径）
  traced.baseUrl.value = traced.baseUrl.value.replace(/\/+$/, '')

  const apiKey = process.env.LLM_API_KEY ?? ''
  return {
    baseUrl: traced.baseUrl,
    model: traced.model,
    apiKey,
    apiKeyFrom: apiKey ? '环境变量 LLM_API_KEY（或 .env）' : '（没有）',
    mock: process.env.MOCK === '1',
    warnings: [...user.warnings, ...project.warnings],
    files: [
      { layer: 'user', path: userFile, exists: user.exists },
      { layer: 'project', path: projectFile, exists: project.exists },
    ],
  }
}

/** 密钥永远打码。日志、截图、issue 里最常见的泄漏就是有人把 --config 的输出整段贴出来 */
export function maskKey(key: string): string {
  if (!key) return '（没有）'
  if (key.length <= 8) return '****'
  return `${key.slice(0, 4)}…${key.slice(-4)}（共 ${key.length} 位）`
}

/** `mca --config` 打印的那几行：每个值 + 它从哪来 + 还有哪几层可以写 */
export function formatConfig(config: ShipConfig): string[] {
  const lines = [
    '当前配置（优先级从低到高：内置默认值 < 用户配置 < 项目配置 < 环境变量 < 命令行参数）',
    `  baseUrl  ${config.baseUrl.value}`,
    `           来自 ${config.baseUrl.from}（${config.baseUrl.layer} 层）`,
    `  model    ${config.model.value}`,
    `           来自 ${config.model.from}（${config.model.layer} 层）`,
    `  apiKey   ${maskKey(config.apiKey)}`,
    `           来自 ${config.apiKeyFrom} —— 密钥不参与分层，配置文件里写了也不算`,
    `  mock     ${config.mock ? '开（MOCK=1，不发任何网络请求）' : '关'}`,
  ]
  for (const file of config.files) {
    lines.push(`  ${file.layer} 层配置文件：${file.path}${file.exists ? '' : '（还没有这个文件）'}`)
  }
  for (const warning of config.warnings) lines.push(`  ⚠ ${warning}`)
  return lines
}

/**
 * 把分层算出来的结果**落回环境变量**，然后什么都不用改。
 *
 * 这一步看着像作弊，其实是本天最值钱的一个决定：前二十天所有读配置的地方
 * （config.ts、providers/index.ts、gateway.ts）读的都是 `process.env.LLM_*`，
 * 而其中三个文件是**冻结**的。新加一层配置有两条路——
 *   ① 把 Config 对象一路传下去：要改二十个文件，其中有冻结文件，做不到；
 *   ② 在入口处把最终值写回环境变量：改一个地方，下游一行不动。
 *
 * 选 ② 的前提是**有且只有一个写入点**，而且它在任何 provider 被造出来之前执行。
 * 否则就会变成「环境变量被谁改过谁也说不清」，那是另一类更难查的故障。
 */
export function applyShipConfig(config: ShipConfig): void {
  process.env.LLM_BASE_URL = config.baseUrl.value
  process.env.LLM_MODEL = config.model.value
}
