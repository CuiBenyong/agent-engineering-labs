/**
 * 图片来源的解析与组装。本天新增，是今天的对外入口。
 *
 * 先说一件反直觉的事：**终端里没有"粘贴一张图片"这回事。**
 * readline 收到的永远是文本，剪贴板里那张位图根本到不了这个进程。所以「粘贴截图」
 * 在一个终端 Agent 里实际上只有两条路，我们两条都收：
 *
 *   1. **粘路径**：`@work/shots/ui.png` —— 用的是第八天那套 @ 引用语法，一个新符号都不加。
 *   2. **粘 data URL**：`data:image/png;base64,iVBOR...` —— 截图工具与浏览器都能直接给出这种串。
 *
 * 第一条路有个坑必须堵：`@` 在第八天是「把这个文件的**文本**贴进上下文」。
 * 一个 .png 走那条路，注入的会是一坨乱码。所以这里先把图片引用挑出来，
 * 再把它们在原文里**转义掉**（`\@`）交给第八天的解析器——转义是第八天就有的机制，
 * 本来就是为了表达「这个 @ 别当引用」。用户的原话一个字没改，两条链路也没有互相知道对方存在。
 *
 * 第二条路的坑是：data URL 动辄几十上百 KB，**它不能留在用户那句话的正文里**。
 * 留着的话，终端刷屏、会话日志爆炸、压缩摘要里塞满 base64。所以摘出来之后，
 * 原地换成一个 `[截图 1]` 的占位符——模型看到的是占位符加一张真图，读起来正好对得上。
 */
import fs from 'node:fs/promises'
import type { ContentPart } from '../kernel/types.js'
import { parseReferences } from '../refs/parse.js'
import type { Root } from '../refs/expand.js'
import { resolveInside } from '../tools/fs.js'
import { probeImage, type ImageInfo } from './probe.js'
import { formatBytes, validateImage, validateTurn } from './validate.js'
import { activeCoefficients } from '../context/tokens.js'

/** 只有这些后缀会被当成图片引用。判「是不是走图片这条路」用扩展名，判格式仍然看字节 */
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|tiff?|avif|heic)$/i
/** data URL 的形状。base64 段按 base64 字母表匹配，遇到空白或中文自然就停了 */
const DATA_URL = /data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/]+={0,2}/gi

export interface Attachment {
  /** 显示给用户的名字：路径，或者「粘贴的截图 1」 */
  label: string
  source: 'path' | 'paste'
  /** 校验通过才有 */
  info?: ImageInfo
  base64?: string
  /** 没通过时的人话原因 */
  problem?: string
}

export interface VisionAttach {
  /** 去掉 data URL、并把图片引用转义之后的那一行，交给第八天的 @ 解析器 */
  maskedLine: string
  attachments: Attachment[]
  /** 终端要打的几行报账 */
  report: string[]
}

export async function attachImages(
  line: string,
  options: { roots: Root[] }
): Promise<VisionAttach> {
  const attachments: Attachment[] = []
  const accepted: ImageInfo[] = []

  // 一、先摘 data URL：它在原文里占的位置最大，早一步摘掉后面的处理都清爽
  let index = 0
  const maskedPaste = line.replace(DATA_URL, (match) => {
    index += 1
    const label = `粘贴的截图 ${index}`
    const base64 = match.slice(match.indexOf(',') + 1)
    attachments.push(admit(label, 'paste', Buffer.from(base64, 'base64'), accepted))
    return `[截图 ${index}]`
  })

  // 二、再挑出指向图片文件的 @ 引用，并在原文里把它们转义掉
  const refs = parseReferences(maskedPaste).filter(
    (ref) => ref.kind === 'path' && IMAGE_EXT.test(ref.target)
  )
  let maskedLine = maskedPaste
  // 从后往前替换：先改后面的，前面那些引用的 start/end 才还是对的
  for (const ref of [...refs].reverse()) {
    maskedLine = `${maskedLine.slice(0, ref.start)}\\${maskedLine.slice(ref.start)}`
  }
  for (const ref of refs) {
    attachments.push(await admitPath(ref.target, options.roots, accepted))
  }

  return { maskedLine, attachments, report: formatReport(attachments) }
}

/** 读盘 + 校验。找不到文件也是一条「有问题的附件」，不是静默跳过 */
async function admitPath(
  target: string,
  roots: Root[],
  accepted: ImageInfo[]
): Promise<Attachment> {
  for (const root of roots) {
    let absolute: string
    try {
      absolute = resolveInside(root.dir, target)
    } catch {
      continue
    }
    try {
      const buf = await fs.readFile(absolute)
      return admit(target, 'path', buf, accepted)
    } catch {
      continue
    }
  }
  const where = roots.map((r) => r.name).join(' 或 ')
  return { label: target, source: 'path', problem: `找不到（在 ${where} 里都没有这个路径）` }
}

/** 三道闸按顺序过：认得出格式吗 → 这一张合格吗 → 这一轮还装得下吗 */
function admit(
  label: string,
  source: 'path' | 'paste',
  buf: Buffer,
  accepted: ImageInfo[]
): Attachment {
  const probed = probeImage(buf)
  if (!probed.ok) return { label, source, problem: probed.problem }

  const bad = validateImage(probed.info) ?? validateTurn(accepted, probed.info)
  if (bad) return { label, source, info: probed.info, problem: bad }

  accepted.push(probed.info)
  return { label, source, info: probed.info, base64: buf.toString('base64') }
}

/**
 * 报账。**两个数字都是可复现的事实，一个都不是"图片折多少 token"的答案。**
 *
 * 原始字节数是文件本身有多大；base64 字符数是真正要走网络的量（base64 一律胀到约 4/3）。
 * 模型侧怎么给图片计费**各家算法不同**，多数不按 base64 长度算，所以这里不换算、不估价——
 * 那是以你所用网关的文档为准的事。打印它们的意义在于：**让"图片很贵"从一句话变成一个数。**
 */
function formatReport(attachments: Attachment[]): string[] {
  if (attachments.length === 0) return []
  const ok = attachments.filter((a) => a.base64)
  const head =
    `图片附件 ${ok.length} 张` +
    (attachments.length > ok.length ? `（另有 ${attachments.length - ok.length} 张被拦下）` : '')
  const rows = attachments.map((a) => {
    if (!a.info || !a.base64) return `  ✘ ${a.label}  ${a.problem ?? '未通过'}`
    const b64 = Math.ceil((a.info.bytes / 3) * 4)
    // base64 段全是 ASCII，所以直接按「其余字符」那个系数折算，不必真去拼一条十几万字符的串
    const asText = Math.max(1, Math.round(b64 * activeCoefficients().rest))
    return (
      `  ✔ ${a.label}  ${a.info.mediaType} ${a.info.width}x${a.info.height} · ` +
      `${formatBytes(a.info.bytes)} · base64 后 ${b64} 字符（同样长度的纯文本约 ${asText} token；` +
      `图片不按这个计费，这一列只用来感受它在报文里有多大，真实计费以你所用网关的文档为准）`
    )
  })
  return [head, ...rows]
}

/** 有图可发时的消息内容：文字一段，每张图一段。文字在前，模型才知道这些图是干嘛的 */
export function buildContent(text: string, attachments: Attachment[]): ContentPart[] {
  const parts: ContentPart[] = [{ type: 'text', text }]
  for (const a of attachments) {
    if (a.info && a.base64)
      parts.push({ type: 'image', mediaType: a.info.mediaType, base64: a.base64 })
  }
  return parts
}

/**
 * 降级用的内容：一张图都不发，改成一段说明。
 *
 * 说明里**只写我们真的知道的事**——格式、尺寸、来自哪里。绝不替模型描述图里有什么，
 * 那就成了我们自己在编。然后明确告诉它「你看不见这张图」，让它去问用户要文字描述，
 * 而不是默默地按猜测干活。
 */
export function buildDegraded(text: string, attachments: Attachment[]): string {
  const rows = attachments
    .filter((a) => a.info && a.base64)
    .map(
      (a, i) =>
        `[截图 ${i + 1}：${a.info?.mediaType} ${a.info?.width}x${a.info?.height}，来自 ${a.label}]`
    )
  if (rows.length === 0) return text
  return (
    `${text}\n\n${rows.join('\n')}\n` +
    '（当前模型不支持图片输入，以上截图没有发给你。不要猜图里有什么：' +
    '请让用户用文字描述关键内容，或者改用支持图片的模型。）'
  )
}
