/**
 * 自检入口：不进 REPL，逐项验证今天该成立的十五件事，打印勾叉后按结果退出。
 *
 * 今天全部离线、全部可复现：图片是本进程用 png.ts 现生成的，字节、宽高、base64 长度
 * 都是确定值；能力探测那两项用的是本文件里写的两个假 provider，一个说实话一个撒谎，
 * 都不发网络请求。没有一项去比耗时，也没有一项依赖端口。
 *
 * **有一件事这里验不了：真实模型到底看没看见那张图。** 离线剧本的台词是写死的，
 * 所以第十四项证明的是「链路通了、文件真的按图改了」，不是「它有视力」。
 * 想验视力，去掉 MOCK=1 用真实 key 跑 /vision probe。
 */
import { stdout } from 'node:process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { newSession } from './session-factory.js'
import { runTurn } from './turn.js'
import { createProvider } from './providers/index.js'
import type { ChatProvider, ChatRequest, StreamDelta } from './providers/types.js'
import { SessionLog, readEvents } from './session/log.js'
import { seedRepo, REPO_DIR } from './seed.js'
import { contentToText, type Message } from './kernel/types.js'
import { scanSkills, type SkillState } from './skills/scan.js'
import { renderTranscript } from './context/summarize.js'
import { solidPng } from './vision/png.js'
import { probeImage, sniffMediaType } from './vision/probe.js'
import { MAX_IMAGE_BYTES, MIN_SIDE, validateImage } from './vision/validate.js'
import { attachImages, buildContent, buildDegraded } from './vision/attach.js'
import { toWireContent, forLog } from './vision/wire.js'
import { probeVision, ensureVision, createVisionState, PROBE_COLORS } from './vision/capability.js'
import { seedDemoShots, SHOTS_DIR, UI_FILE, UI_WIDTH, UI_HEIGHT } from './vision/demo.js'

const out = (line: string) => stdout.write(`${line}\n`)
let passed = 0
let failed = 0

function check(ok: boolean, label: string): void {
  out(`${ok ? '✔' : '✘'} ${label}`)
  if (ok) passed += 1
  else failed += 1
}

/** 照图改文案那一句。同时带一个图片引用，走的是今天的完整链路 */
const SHOT_LINE = '照着这张截图把工具栏的主按钮文案改一下 @work/shots/ui.png'

/** 一个只会说一个词的假 provider。用来验能力探测的两支，不发任何网络请求 */
class WordProvider implements ChatProvider {
  readonly id = 'fake'
  readonly model = 'fake-model'
  constructor(private readonly word: string) {}
  async *stream(_req: ChatRequest): AsyncIterable<StreamDelta> {
    yield { type: 'text', text: this.word }
    yield { type: 'finish', reason: 'stop' }
  }
}

async function main(): Promise<void> {
  await seedRepo()
  const shots = await seedDemoShots()

  // 1. 演示素材是代码现生成的，不是仓库里的二进制文件
  const uiBytes = await fs.readFile(path.join(SHOTS_DIR, 'ui.png'))
  const probed = probeImage(uiBytes)
  check(
    shots.files.length === 4 &&
      probed.ok &&
      probed.info.width === UI_WIDTH &&
      probed.info.height === UI_HEIGHT,
    `演示素材：${shots.files.length} 份，ui.png 解出 ${probed.ok ? `${probed.info.width}x${probed.info.height}` : '失败'}（字节由 png.ts 现拼，仓库里没有二进制）`
  )

  // 2. 魔数优先于扩展名：名字叫 .jpg，字节是 PNG
  const fake = await fs.readFile(path.join(SHOTS_DIR, 'screenshot.jpg'))
  check(
    sniffMediaType(fake) === 'image/png',
    `扩展名不作数：screenshot.jpg 的字节头说它是 ${sniffMediaType(fake)}，我们按字节走`
  )

  // 3. JPEG 的宽高要沿着 marker 走才读得到，而且不能把霍夫曼表当成 SOF
  const jpeg = miniJpeg(200, 120)
  const jprobe = probeImage(jpeg)
  check(
    jprobe.ok &&
      jprobe.info.mediaType === 'image/jpeg' &&
      jprobe.info.width === 200 &&
      jprobe.info.height === 120,
    `JPEG 尺寸：走过一段霍夫曼表之后读到 ${jprobe.ok ? `${jprobe.info.width}x${jprobe.info.height}` : '失败'}（把 C4 当成 SOF 会读出一个离谱的数且不报错）`
  )

  // 4. 认不出格式的东西要说清楚，不许当成图片发出去
  const junk = probeImage(Buffer.from('this is not an image at all'))
  check(
    !junk.ok && junk.problem.includes('看不出'),
    `不认识就说不认识：「${junk.ok ? '' : junk.problem.slice(0, 28)}…」`
  )

  // 5. 尺寸下限：4x4 被拦下，同一套字节拼出来的 640x400 通过
  const tiny = probeImage(await fs.readFile(path.join(SHOTS_DIR, 'ui-tiny.png')))
  const tinyProblem = tiny.ok ? validateImage(tiny.info) : '解析就失败了'
  check(
    Boolean(tinyProblem) &&
      String(tinyProblem).includes(String(MIN_SIDE)) &&
      probed.ok &&
      validateImage(probed.info) === null,
    `下限闸：4x4 被拦下并说「${String(tinyProblem).slice(0, 30)}…」，${UI_WIDTH}x${UI_HEIGHT} 直接放行`
  )

  // 6. 体积上限：造一张真的超线的图，确认拦的是字节数不是像素数
  const big = solidPng(1400, 1400, [17, 17, 17])
  const bigInfo = probeImage(big)
  const bigProblem = bigInfo.ok
    ? validateImage({ ...bigInfo.info, bytes: MAX_IMAGE_BYTES + 1 })
    : null
  check(
    Boolean(bigProblem) && String(bigProblem).includes('超过单张上限'),
    `体积闸：超过 ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB 的图被拦下并建议先压再贴`
  )

  // 7. @ 引用被路由到图片这条路，而且在原文里被转义掉了
  const attach = await attachImages(SHOT_LINE, {
    roots: [
      { name: 'work/repo', dir: REPO_DIR },
      { name: '当前目录', dir: process.cwd() },
    ],
  })
  check(
    attach.attachments.length === 1 &&
      Boolean(attach.attachments[0]?.base64) &&
      attach.maskedLine.includes('\\@work/shots/ui.png'),
    `路由：ui.png 走图片通道（${attach.attachments[0]?.info?.bytes} 字节），原文里那个 @ 被转义成 \\@ 交给第八天的解析器`
  )

  // 8. 粘贴的 data URL 从正文里被摘掉，换成占位符
  const dataUrl = `data:image/png;base64,${uiBytes.toString('base64')}`
  const pasted = await attachImages(`看这个 ${dataUrl} 帮我改文案`, { roots: [] })
  check(
    pasted.attachments.length === 1 &&
      pasted.maskedLine.includes('[截图 1]') &&
      !pasted.maskedLine.includes('base64,') &&
      pasted.maskedLine.length < 40,
    `粘贴：${dataUrl.length} 字符的 data URL 被摘走，正文只剩 ${pasted.maskedLine.length} 字符「${pasted.maskedLine}」`
  )

  // 9. 消息结构：带图才变数组，纯文本仍是字符串
  const withImage = buildContent('照图改文案', attach.attachments)
  check(
    Array.isArray(withImage) &&
      withImage.length === 2 &&
      withImage[0]?.type === 'text' &&
      withImage[1]?.type === 'image' &&
      typeof toWireContent('一句纯文本') === 'string',
    `兼容性：带图的 content 是 ${withImage.length} 段的数组，纯文本消息仍旧是字符串（提示缓存按前缀命中，不为统一而统一）`
  )

  // 10. 线协议映射：image 段变成 image_url 加一个 data URL
  const wire = toWireContent(withImage)
  const img = Array.isArray(wire)
    ? (wire[1] as { type?: string; image_url?: { url?: string } } | undefined)
    : undefined
  const url = img?.image_url?.url ?? ''
  check(
    img?.type === 'image_url' && url.startsWith('data:image/png;base64,'),
    `线协议：第二段变成 ${img?.type ?? '（没翻译，还是一段纯文本）'}，url 以 ${url.slice(0, 22) || '（无）'}… 开头`
  )

  // 11. 日志投影：base64 不进 jsonl。反向确认不是恒真——原消息里那段 base64 确实存在
  const message: Message = { role: 'user', content: withImage }
  const logged = forLog(message)
  const loggedText = contentToText(logged.content)
  const rawB64 = attach.attachments[0]?.base64 ?? ''
  check(
    rawB64.length > 1000 &&
      !JSON.stringify(logged).includes(rawB64.slice(0, 64)) &&
      loggedText.includes('正文未入日志'),
    `日志投影：原消息里 ${rawB64.length} 字符的 base64 没进日志，只留「${loggedText.slice(loggedText.indexOf('[截图'), loggedText.indexOf('[截图') + 34)}…」`
  )

  // 12. 压缩转录里同样没有 base64——这一条第一天就赢了，contentToText 在协议层
  const transcript = renderTranscript([message])
  check(
    !transcript.includes(rawB64.slice(0, 64)) && transcript.includes('[图片 image/png]'),
    '压缩转录：图片在转录里是一个标记而不是正文，所以摘要请求不会把截图再发一遍'
  )

  // 13. 能力探测：撒谎的那个被判为不支持，而它全程没有报任何错
  const red = PROBE_COLORS[0] as (typeof PROBE_COLORS)[number]
  const honest = await probeVision(new WordProvider('红色'), red)
  const liar = await probeVision(new WordProvider('蓝绿色'), red)
  check(
    honest.ok && !liar.ok && liar.answer === '蓝绿色',
    `可验证的判据：问同一张纯红图，说「${honest.answer}」的判为支持，说「${liar.answer}」的判为不支持——后者一个错都没报`
  )

  // 14. 降级：判为不支持时消息里一张图都没有，但有一段说明；离线剧本一律跳过探测
  const off = createVisionState()
  off.support = 'no'
  const degraded = buildDegraded('照图改文案', attach.attachments)
  const mockState = createVisionState()
  await ensureVision(createProvider(), mockState)
  check(
    !degraded.includes('base64') &&
      degraded.includes(`${UI_WIDTH}x${UI_HEIGHT}`) &&
      degraded.includes('不要猜图里有什么') &&
      mockState.support === 'yes' &&
      mockState.note.includes('跳过探测'),
    `降级：不发图时只留一行「${degraded.slice(degraded.indexOf('[截图'), degraded.indexOf('[截图') + 26)}…」并明说不许猜；离线剧本跳过探测`
  )

  // 15. 端到端：贴一张截图，模型照图改掉 src/ui.js 的文案，且 cancel 没被动
  await seedRepo()
  await seedDemoShots()
  const session = await freshSession()
  const turn = await runTurn({
    session,
    provider: createProvider(),
    line: SHOT_LINE,
    write: () => {},
    out: () => {},
    approve: async () => ({ approved: true, scope: 'once' }),
    tty: false,
  })
  const ui = await fs.readFile(path.join(REPO_DIR, UI_FILE), 'utf8')
  const userMessage = session.messages.find((m) => m.role === 'user' && Array.isArray(m.content))
  const events = await readEvents(session.log.id)
  const logSize = (
    await fs.stat(path.join(process.cwd(), 'work/sessions', `${session.log.id}.jsonl`))
  ).size
  check(
    turn.summary.tools.map((t) => t.name).join(',') === 'read_file,edit_file' &&
      ui.includes("submit: '保存并提交'") &&
      ui.includes("cancel: '取消'") &&
      Array.isArray(userMessage?.content) &&
      events.stoppedAtLine === null &&
      logSize < rawB64.length,
    `端到端：先 read_file 再 edit_file，submit 改成了「保存并提交」而 cancel 没动；` +
      `整个会话日志 ${logSize} 字节，比那张图的 base64（${rawB64.length} 字符）还小`
  )

  out(`${passed}/${passed + failed} 通过`)
  out(
    '（全部离线可复现：图片由 png.ts 现拼，宽高、字节数、base64 长度都是确定值；' +
      '能力探测用的是本文件里两个不发网络请求的假 provider。' +
      '离线剧本证明的是链路通了，不是模型真的有视力——那一条要用真实 key 跑 /vision probe。）'
  )
  if (failed > 0) process.exitCode = 1
}

/**
 * 手拼一段最小 JPEG：SOI + 一段霍夫曼表(C4) + SOF0(C0) + EOI。
 *
 * 故意把霍夫曼表放在 SOF 前面：它的编号 C4 正好落在 C0–CF 这个区间里，
 * 而解析器必须跳过它。少了那条判断，读出来的宽高来自表里的字节——**而且不会报错**。
 */
function miniJpeg(width: number, height: number): Buffer {
  const dht = Buffer.alloc(2 + 2 + 20)
  dht.writeUInt16BE(0xffc4, 0)
  dht.writeUInt16BE(2 + 20, 2)
  dht.fill(0x7f, 4) // 表里塞一堆 0x7f：读错了就会得到 32639 这种一眼假的宽高
  const sof = Buffer.alloc(2 + 2 + 6)
  sof.writeUInt16BE(0xffc0, 0)
  sof.writeUInt16BE(2 + 6, 2)
  sof[4] = 8
  sof.writeUInt16BE(height, 5)
  sof.writeUInt16BE(width, 7)
  return Buffer.concat([Buffer.from([0xff, 0xd8]), dht, sof, Buffer.from([0xff, 0xd9])])
}

/** 每次都用扫描出来的真实技能建会话，好让阶段一摘要真的进系统提示 */
async function freshSession() {
  const scanned = await scanSkills()
  const state: SkillState = { ...scanned, pinned: [] }
  return newSession(() => {}, await SessionLog.create(), { skills: state })
}

await main()
