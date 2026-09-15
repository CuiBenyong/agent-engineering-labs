// 语料 → 块 → 放大到可以看出索引差别的规模。
//
// 三十篇真语料只能切出两三百块，这个量级下 HNSW 和暴力扫描没有任何区别，
// 参数扫描全是噪声。所以本天在真语料之上用确定性伪随机拼出若干「合成块」，
// 把行数推到 SCALE（默认 20000）。合成块只是把真语料的句子重新组合，
// 它不用来回答问题，只用来把向量空间填到有密度——本天量的是索引，不是检索效果。

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CORPUS_DIR = path.resolve(HERE, '../../corpus')

export interface Chunk {
  chunkId: string
  docId: string
  department: string
  tenantId: string
  text: string
}

interface Doc {
  id: string
  title: string
  department: string
  updated: string
  body: string
}

/** 稀有租户：只占 1% 的行。带过滤的漏召回演示全靠它 */
export const RARE_TENANT = 't07'
const OTHER_TENANTS = [
  't01',
  't02',
  't03',
  't04',
  't05',
  't06',
  't08',
  't09',
  't10',
  't11',
  't12',
  't13',
  't14',
  't15',
  't16',
  't17',
  't18',
  't19',
  't20',
]

/** 每 100 行固定有一行属于稀有租户，跟内容无关，所以不会引入内容相关性 */
function tenantFor(rowIndex: number): string {
  if (rowIndex % 100 === 7) return RARE_TENANT
  return OTHER_TENANTS[rowIndex % OTHER_TENANTS.length]
}

function parseDoc(file: string): Doc {
  const raw = readFileSync(path.join(CORPUS_DIR, file), 'utf8')
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw)
  if (!match) throw new Error(`语料 ${file} 缺少 frontmatter`)
  const meta: Record<string, string> = {}
  for (const line of match[1].split('\n')) {
    const sep = line.indexOf(':')
    if (sep > 0) meta[line.slice(0, sep).trim()] = line.slice(sep + 1).trim()
  }
  return {
    id: meta.id,
    title: meta.title,
    department: meta.department,
    updated: meta.updated,
    body: match[2],
  }
}

export function readCorpus(): Doc[] {
  return readdirSync(CORPUS_DIR)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map(parseDoc)
}

/** 按段落攒到 180 字左右切一块。切块本身是 D4 的题目，这里用最朴素的一种 */
function chunkDoc(doc: Doc): Chunk[] {
  const paragraphs = doc.body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
  const chunks: Chunk[] = []
  let buffer = ''
  const flush = () => {
    if (!buffer) return
    const seq = String(chunks.length + 1).padStart(2, '0')
    chunks.push({
      chunkId: `${doc.id}#c${seq}`,
      docId: doc.id,
      department: doc.department,
      tenantId: '',
      text: `${doc.title}\n${buffer}`,
    })
    buffer = ''
  }
  for (const paragraph of paragraphs) {
    buffer = buffer ? `${buffer} ${paragraph}` : paragraph
    if (buffer.length >= 180) flush()
  }
  flush()
  return chunks
}

/** mulberry32：三十行的确定性伪随机，换一台机器跑出来的合成块也是同一批 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface Dataset {
  rows: Chunk[]
  realCount: number
}

export function buildDataset(scale: number): Dataset {
  const real: Chunk[] = []
  for (const doc of readCorpus()) real.push(...chunkDoc(doc))

  const sentences = real
    .flatMap((chunk) => chunk.text.split(/[。；\n]/))
    .map((s) => s.trim())
    .filter((s) => s.length >= 8)

  const rows: Chunk[] = real.map((chunk, i) => ({ ...chunk, tenantId: tenantFor(i) }))
  const random = mulberry32(20260906)
  let synthetic = 0
  while (rows.length < scale) {
    const parts: string[] = []
    const partCount = 2 + Math.floor(random() * 3)
    for (let i = 0; i < partCount; i += 1) {
      parts.push(sentences[Math.floor(random() * sentences.length)])
    }
    synthetic += 1
    rows.push({
      chunkId: `syn-${String(synthetic).padStart(6, '0')}`,
      docId: 'syn',
      department: 'eng',
      tenantId: tenantFor(rows.length),
      text: parts.join('。'),
    })
  }
  return { rows, realCount: real.length }
}

/** 固定的一批查询。同一批查询跑遍所有配置，才谈得上横向对照 */
export const QUERIES = [
  '单个文件最大能上传多大',
  '删掉的文件在回收站里能保留多久',
  '生产数据库主备切换需要谁审批',
  '变更评审会什么时候开',
  '开放 API 的默认限流是多少',
  '年假最多能结转几天到第二年',
  'P0 故障要求多久之内响应',
  '任务板支持哪几种视图',
  '文档的版本历史能回溯多久',
  '单点登录怎么配置',
  '双因素认证支持哪些方式',
  '灰度发布分几个批次',
  '监控告警的分级标准是什么',
  '工单响应时效怎么算',
  '试用期考核由谁负责',
  '请假和调休怎么申请',
  '数据导出支持哪些格式',
  '移动端离线模式能做什么',
  '账单续费和退款规则',
  '消息免打扰怎么设置',
]
