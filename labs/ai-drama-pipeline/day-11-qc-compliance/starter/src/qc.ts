// D11 的第一块：把「好不好看」拆成一组能打分的检查项。
// 判据只有一条：**这一项能不能在没有人的情况下判出真假**。判不出来的，就别写成检查项，
// 写成「交给模型评一句」并且明确标出它是主观项。

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Shot, TextProvider } from './providers/index.js'

const run = promisify(execFile)

export const PASS_SCORE = 3
export const MAX_REDO = 2

export type CheckId = 'resolution' | 'av-sync' | 'subtitle-fit' | 'audio-level' | 'visual-integrity'

export type CheckResult = { id: CheckId; score: number; objective: boolean; detail: string }

export type ShotQc = {
  shotId: string
  scores: CheckResult[]
  min: number
  passed: boolean
  redo: number
  verdict: 'pass' | 'redo' | 'needs-human'
}

/** 竖屏短剧一屏放得下的字数上限，以及一秒钟人眼能读完的字数上限。 */
const MAX_SUBTITLE_CHARS = 20
const MAX_CHARS_PER_SECOND = 6

async function probe(path: string, entries: string): Promise<string> {
  const { stdout } = await run('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    entries,
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    path,
  ])
  return stdout.trim()
}

export async function durationMs(path: string): Promise<number> {
  const { stdout } = await run('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    path,
  ])
  return Math.round(Number.parseFloat(stdout.trim()) * 1000)
}

/** 平均响度：ffmpeg 的 volumedetect 不需要任何额外的库，最小 build 也能跑。 */
export async function meanVolumeDb(path: string): Promise<number> {
  const { stderr } = await run('ffmpeg', [
    '-v',
    'info',
    '-i',
    path,
    '-af',
    'volumedetect',
    '-f',
    'null',
    '-',
  ])
  const m = /mean_volume:\s*(-?[\d.]+) dB/.exec(stderr)
  return m ? Number(m[1]) : Number.NaN
}

const scoreOf = (ok: boolean, near: boolean) => (ok ? 5 : near ? 3 : 1)

/** 分辨率：最硬的一项，错了整条发行链都白搭。 */
export async function checkResolution(clipPath: string): Promise<CheckResult> {
  const [w, h] = (await probe(clipPath, 'stream=width,height')).split('\n').map(Number)
  const ok = w === 1080 && h === 1920
  return {
    id: 'resolution',
    score: ok ? 5 : 1,
    objective: true,
    detail: `${w}x${h}${ok ? '' : '（要求 1080x1920 竖屏）'}`,
  }
}

/** 音画不同步：配音比画面长就一定会被切掉半句，这是可以直接量的。 */
export async function checkAvSync(clipPath: string, voicePath: string): Promise<CheckResult> {
  const delta = Math.abs((await durationMs(clipPath)) - (await durationMs(voicePath)))
  return {
    id: 'av-sync',
    score: scoreOf(delta <= 400, delta <= 900),
    objective: true,
    detail: `画面与配音相差 ${delta}ms`,
  }
}

/** 字幕出框：一屏放不下、或者一秒钟读不完，都算不合格。阈值是本课定的，不是行业标准。 */
export function checkSubtitleFit(text: string, durationSec: number): CheckResult {
  const perSecond = Number((text.length / Math.max(1, durationSec)).toFixed(2))
  // 练习 1：把「字幕会不会出框」变成可判定的检查项。
  // 判据两条：单条不超过 MAX_SUBTITLE_CHARS 字，且每秒不超过 MAX_CHARS_PER_SECOND 字。
  // 提示：用 scoreOf(合格, 接近合格) 给分。现在这样永远满分，等于没检查——
  //       跑起来会看到 33 个字塞进 4 秒也一路绿灯。
  void MAX_SUBTITLE_CHARS
  void MAX_CHARS_PER_SECOND
  void scoreOf
  return {
    id: 'subtitle-fit',
    score: 5,
    objective: true,
    detail: `${text.length} 字 / ${durationSec} 秒 = 每秒 ${perSecond} 字（检查未实现）`,
  }
}

/** 配音响度：太轻在手机外放上听不见，太响会被平台压。区间是本课定的，以你自己的发行平台为准。 */
export async function checkAudioLevel(voicePath: string): Promise<CheckResult> {
  const db = await meanVolumeDb(voicePath)
  const ok = db >= -30 && db <= -6
  return {
    id: 'audio-level',
    score: scoreOf(ok, db >= -36 && db <= -3),
    objective: true,
    detail: `平均响度 ${db} dB（合格区间 -30 到 -6）`,
  }
}

/**
 * 主观项交给模型。要求它只回一个 JSON，解析不出来就当这一项没结论、需要人看，
 * **绝不当成通过**——把「模型没答上来」和「模型说没问题」混为一谈是最危险的写法。
 */
export type Reviewer = { review(shot: Shot, facts: CheckResult[]): Promise<CheckResult> }

export function createReviewer(text: TextProvider, offline: boolean): Reviewer {
  if (offline) return offlineReviewer()
  return {
    async review(shot, facts) {
      const prompt = [
        '你是短剧质检员。只输出一个 JSON，形如 {"score":1到5的整数,"detail":"一句话"}。',
        `画面描述：${shot.visual}；运镜：${shot.camera}`,
        `本地已测得：${facts.map((f) => `${f.id}=${f.score}`).join('，')}`,
        '请就角色一致性与画面是否崩坏（多手多指、结构错乱、明显糊）打分。',
      ].join('\n')
      const r = await text.complete({ user: prompt, temperature: 0 })
      try {
        const parsed = JSON.parse(
          r.text.slice(r.text.indexOf('{'), r.text.lastIndexOf('}') + 1)
        ) as { score?: number; detail?: string }
        const score = Number(parsed.score)
        if (!Number.isInteger(score) || score < 1 || score > 5) throw new Error('分数不在 1–5')
        return {
          id: 'visual-integrity',
          score,
          objective: false,
          detail: String(parsed.detail ?? ''),
        }
      } catch {
        return {
          id: 'visual-integrity',
          score: 0,
          objective: false,
          detail: '模型没给出可解析的分数，本项无结论，需人工复核',
        }
      }
    },
  }
}

/**
 * 离线评审官：真实环境这一项由多模态模型看图打分（角色一致性、多手多指、结构错乱）。
 * 离线时按画面描述里的高风险特征给一个确定的分，好让「打回 → 重做 → 止损」这条路真的被走到。
 */
const RISKY = /多人|同时伸手|六只手|群像|复杂手部/
function offlineReviewer(): Reviewer {
  return {
    async review(shot) {
      const risky = RISKY.test(shot.visual)
      return {
        id: 'visual-integrity',
        score: risky ? 2 : 4,
        objective: false,
        detail: risky
          ? '离线评审：画面描述含多人多手，崩坏风险高（真实环境由多模态模型看图判定）'
          : '离线评审：画面描述简单，风险低（真实环境由多模态模型看图判定）',
      }
    },
  }
}

export function summarize(shotId: string, scores: CheckResult[], redo: number): ShotQc {
  const min = Math.min(...scores.map((s) => s.score))
  const passed = min >= PASS_SCORE
  // 练习 2：补上止损点。低于 PASS_SCORE 就该打回重做，但重做到 MAX_REDO 次还不达标
  // 就必须停手、标成 needs-human 交给人，而不是无限重试或者干脆放行。
  // 提示：现在这样是「不达标也算过」，最贵的镜头会被一路放到成片里。
  void MAX_REDO
  const verdict: ShotQc['verdict'] = 'pass'
  return { shotId, scores, min, passed, redo, verdict }
}
