import { createHash } from 'node:crypto'
import type { Doc, Department } from './corpus'
import { cosine, embed } from './embed'

/**
 * 切块产物的节点结构。字段名由第三天定下，全课统一，不许改：
 *
 *   { docId, chunkId, text, headingPath, page, department, updatedAt, contentHash }
 *
 * 本天多带一个 `parentId`：只有父子切法会填，其余四种是 null。
 */
export interface Chunk {
  docId: string
  chunkId: string
  text: string
  headingPath: string[]
  page: number | null
  department: Department
  updatedAt: string
  contentHash: string
  parentId: string | null
}

export interface ChunkSet {
  name: string
  /** 进索引、被检索的那一批块 */
  chunks: Chunk[]
  /** 父子切法才非空：子块命中后按 parentId 回填的大块 */
  parents: Map<string, Chunk>
}

/** 五个切块器共用的签名——统一接口是这个实验能做对照的前提 */
export type Chunker = (docs: Doc[]) => Promise<ChunkSet>

// ---------------------------------------------------------------------------
// 公共工具
// ---------------------------------------------------------------------------

/** 内容指纹取整篇文档的 sha256 前 16 位，第十三天的增量同步靠它判断要不要重切 */
function fingerprint(body: string): string {
  return createHash('sha256').update(body).digest('hex').slice(0, 16)
}

interface Section {
  headingPath: string[]
  text: string
}

/**
 * 把一篇 Markdown 按标题层级切成小节，并记住每一节的标题路径。
 * 这是「按结构切」的基础，也是另外四种切法算 headingPath 的依据——
 * 结构信息是第三天解析阶段留下来的，这里只是取用，丢了就再也补不回来。
 */
function splitSections(body: string): Section[] {
  const sections: Section[] = []
  const stack: string[] = []
  let buffer: string[] = []
  let path: string[] = []

  const flush = () => {
    const text = buffer.join('\n').trim()
    if (text) sections.push({ headingPath: [...path], text })
    buffer = []
  }

  for (const line of body.split('\n')) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      flush()
      const level = heading[1].length
      stack.length = Math.min(stack.length, level - 1)
      stack[level - 1] = heading[2].trim()
      path = stack.filter(Boolean)
      continue
    }
    buffer.push(line)
  }
  flush()
  return sections
}

/** 把整篇拼成一条连续文本，同时记下每一节起点的字符偏移，供固定长度等切法回查标题路径 */
function flatten(doc: Doc): { full: string; marks: { offset: number; headingPath: string[] }[] } {
  const sections = splitSections(doc.body)
  const marks: { offset: number; headingPath: string[] }[] = []
  const parts: string[] = []
  let offset = 0
  for (const section of sections) {
    marks.push({ offset, headingPath: section.headingPath })
    parts.push(section.text)
    offset += section.text.length + 2 // 两个换行的分隔
  }
  return { full: parts.join('\n\n'), marks }
}

function headingPathAt(
  marks: { offset: number; headingPath: string[] }[],
  offset: number
): string[] {
  let current: string[] = []
  for (const mark of marks) {
    if (mark.offset > offset) break
    current = mark.headingPath
  }
  return current
}

function makeChunk(
  doc: Doc,
  hash: string,
  index: number,
  text: string,
  headingPath: string[],
  parentId: string | null = null
): Chunk {
  return {
    docId: doc.id,
    chunkId: `${doc.id}#c${String(index).padStart(2, '0')}`,
    text,
    headingPath,
    page: null, // 只有 PDF 来源有页码，本课语料全是 Markdown
    department: doc.department,
    updatedAt: doc.updated,
    contentHash: hash,
    parentId,
  }
}

// ---------------------------------------------------------------------------
// 一、固定长度
// ---------------------------------------------------------------------------

export const FIXED_SIZE = 400
export const FIXED_OVERLAP = 80

/**
 * 最简单的一种：不看任何结构，按字符数硬切。
 * 唯一的补救手段就是重叠区——让相邻两块共享一段尾巴，
 * 使得「被切开的那句话」至少在其中一块里是完整的。
 */
export function chunkFixed(size = FIXED_SIZE, overlap = FIXED_OVERLAP): Chunker {
  return async (docs) => {
    const chunks: Chunk[] = []
    for (const doc of docs) {
      const { full, marks } = flatten(doc)
      const hash = fingerprint(doc.body)
      const step = Math.max(1, size - overlap)
      let index = 0
      for (let start = 0; start < full.length; start += step) {
        const text = full.slice(start, start + size).trim()
        if (!text) continue
        chunks.push(makeChunk(doc, hash, (index += 1), text, headingPathAt(marks, start)))
        if (start + size >= full.length) break
      }
    }
    return { name: 'fixed', chunks, parents: new Map() }
  }
}

// ---------------------------------------------------------------------------
// 二、递归切分
// ---------------------------------------------------------------------------

/** 分隔符按「语义边界从强到弱」排列：段落 > 换行 > 句号 > 逗号 > 硬切 */
const SEPARATORS = ['\n\n', '\n', '。', '；', '，', '']

/**
 * 递归切分：先用最强的分隔符切，切完还超长的那一段再用次强的切，一直退到硬切。
 * 分隔符优先级为什么重要——它决定了「不得不切开」时你牺牲的是段落边界还是句子边界。
 */
function splitRecursive(text: string, size: number, depth = 0): string[] {
  if (text.length <= size) return [text]
  const sep = SEPARATORS[Math.min(depth, SEPARATORS.length - 1)]
  if (sep === '') {
    const out: string[] = []
    for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size))
    return out
  }
  const pieces = text
    .split(sep)
    .map((p, i, arr) => (i < arr.length - 1 ? p + sep : p))
    .filter((p) => p.trim())
  return pieces.flatMap((p) => splitRecursive(p, size, depth + 1))
}

/** 把切碎的原子块贪心地并回接近目标长度，并在块首补上一段重叠 */
function mergeWithOverlap(atoms: string[], size: number, overlap: number): string[] {
  const merged: string[] = []
  let current = ''
  for (const atom of atoms) {
    if (current && current.length + atom.length > size) {
      merged.push(current.trim())
      current = overlap > 0 ? current.slice(-overlap) : ''
    }
    current += atom
  }
  if (current.trim()) merged.push(current.trim())
  return merged
}

export function chunkRecursive(size = FIXED_SIZE, overlap = FIXED_OVERLAP): Chunker {
  return async (docs) => {
    const chunks: Chunk[] = []
    for (const doc of docs) {
      const { full, marks } = flatten(doc)
      const hash = fingerprint(doc.body)
      const texts = mergeWithOverlap(splitRecursive(full, size), size, overlap)
      let cursor = 0
      texts.forEach((text, i) => {
        const at = full.indexOf(text.slice(0, 20), cursor)
        if (at >= 0) cursor = at
        chunks.push(makeChunk(doc, hash, i + 1, text, headingPathAt(marks, cursor)))
      })
    }
    return { name: 'recursive', chunks, parents: new Map() }
  }
}

// ---------------------------------------------------------------------------
// 三、按文档结构
// ---------------------------------------------------------------------------

export const STRUCTURE_MAX = 700

/**
 * 标题层级天然就是作者划好的语义边界，直接拿来当块边界，比任何长度启发式都准。
 * 前提是第三天的解析没把结构丢掉——解析器一旦把标题压成普通段落，这条路就断了。
 * 小节超过上限时退回递归切分，避免出现一个超长块。
 */
export function chunkStructure(max = STRUCTURE_MAX): Chunker {
  return async (docs) => {
    const chunks: Chunk[] = []
    for (const doc of docs) {
      const hash = fingerprint(doc.body)
      let index = 0
      for (const section of splitSections(doc.body)) {
        for (const text of splitRecursive(section.text, max)) {
          chunks.push(makeChunk(doc, hash, (index += 1), text.trim(), section.headingPath))
        }
      }
    }
    return { name: 'structure', chunks, parents: new Map() }
  }
}

// ---------------------------------------------------------------------------
// 四、父子切块
// ---------------------------------------------------------------------------

export const CHILD_SIZE = 200
export const CHILD_OVERLAP = 40

/**
 * 小块用来检索、大块用来喂给模型：检索时短块的信噪比高，命中之后按 parentId 把整节回填进上下文，
 * 于是精度和完整度可以同时拿到。索引与回填的完整实现、成本与评估在第十一天展开，
 * 这里只做到能看出「检索单位」与「上下文单位」可以不是同一个东西。
 */
export function chunkParentChild(childSize = CHILD_SIZE, overlap = CHILD_OVERLAP): Chunker {
  return async (docs) => {
    const chunks: Chunk[] = []
    const parents = new Map<string, Chunk>()
    for (const doc of docs) {
      const hash = fingerprint(doc.body)
      let parentIndex = 0
      let childIndex = 0
      for (const section of splitSections(doc.body)) {
        const parent = makeChunk(doc, hash, (parentIndex += 1), section.text, section.headingPath)
        const parentId = `${doc.id}#p${String(parentIndex).padStart(2, '0')}`
        parents.set(parentId, { ...parent, chunkId: parentId })
        for (const text of mergeWithOverlap(
          splitRecursive(section.text, childSize),
          childSize,
          overlap
        )) {
          chunks.push(makeChunk(doc, hash, (childIndex += 1), text, section.headingPath, parentId))
        }
      }
    }
    return { name: 'parent-child', chunks, parents }
  }
}

// ---------------------------------------------------------------------------
// 五、语义切分
// ---------------------------------------------------------------------------

export const SEMANTIC_MIN = 150
export const SEMANTIC_MAX = 600
export const SEMANTIC_PERCENTILE = 0.25

/** 按句末标点切句；语义切分是在句子这个粒度上找断点的，不是在字符上 */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[。！？；\n])/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * 语义切分：逐句算 embedding，相邻两句相似度掉下去的地方就认为话题变了，在那里断开。
 *
 * 阈值不能拍一个绝对值——不同 embedding 模型的相似度分布完全不同，写死 0.55 换个模型就全断或全不断。
 * 正确做法是取**分位数**：把本篇所有相邻相似度排序，只在最不像的那 25% 处断开。
 * 再加一个最小块长兜底，否则一句话一块，块小到没有语境，检索反而更差。
 *
 * 贵在哪一目了然——每篇文档的每一句都要过一次向量接口，切块阶段第一次出现了按量计费的成本。
 * 值不值，要看它换来的命中率涨幅，这也是本实验对照表要回答的问题。
 */
export function chunkSemantic(
  min = SEMANTIC_MIN,
  max = SEMANTIC_MAX,
  percentile = SEMANTIC_PERCENTILE
): Chunker {
  return async (docs) => {
    const chunks: Chunk[] = []
    for (const doc of docs) {
      const { marks } = flatten(doc)
      const hash = fingerprint(doc.body)
      const sentences = splitSentences(doc.body.replace(/^#{1,6}\s+/gm, ''))
      const vectors = await embed(sentences)

      const sims = sentences.slice(1).map((_, i) => cosine(vectors[i], vectors[i + 1]))
      const sorted = [...sims].sort((a, b) => a - b)
      const threshold = sorted[Math.floor(sorted.length * percentile)] ?? -1

      let index = 0
      let buffer: string[] = []
      let offset = 0
      let bufferOffset = 0

      const flush = () => {
        const text = buffer.join('').trim()
        if (text) {
          chunks.push(makeChunk(doc, hash, (index += 1), text, headingPathAt(marks, bufferOffset)))
        }
        buffer = []
      }

      for (let i = 0; i < sentences.length; i += 1) {
        const length = buffer.join('').length
        const tooLong = length + sentences[i].length > max
        const topicShift = i > 0 && length >= min && sims[i - 1] <= threshold
        if (buffer.length > 0 && (tooLong || topicShift)) {
          flush()
          bufferOffset = offset
        }
        if (buffer.length === 0) bufferOffset = offset
        buffer.push(sentences[i])
        offset += sentences[i].length
      }
      flush()
    }
    return { name: 'semantic', chunks, parents: new Map() }
  }
}
