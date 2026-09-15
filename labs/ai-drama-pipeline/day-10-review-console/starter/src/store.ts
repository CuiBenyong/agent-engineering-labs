// D10 的核心：审核台的状态。人的每一次修改都变成一个新版本，旧版本原地留着能对回去。
// 关键判断：**版本不是备份**。备份是「出事了拿回来」，版本是「两个都在，随时对比」。

import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import {
  affectedNodes,
  nodeId,
  TIMELINE_NODE,
  type EditableField,
  type ReviewNote,
  type ShotState,
  type ShotVersion,
} from './model.js'
import type { Providers, Shot } from './providers/index.js'
import { CAST, draftShots } from './fixtures.js'
import { Run, writeJson } from './run.js'

export async function sha1(path: string): Promise<string> {
  return createHash('sha1')
    .update(await readFile(path))
    .digest('hex')
    .slice(0, 12)
}

export class ReviewStore {
  readonly shots: ShotState[] = []
  readonly reviews: ReviewNote[] = []
  /** 人改完还没点重生成的草稿。审核台上「改了但没生效」必须看得见。 */
  readonly pending = new Map<string, { field: EditableField; value: string; affected: string[] }>()

  constructor(
    readonly run: Run,
    private readonly providers: Providers
  ) {}

  private state(shotId: string): ShotState {
    const s = this.shots.find((x) => x.shot.id === shotId)
    if (!s) throw new Error(`没有这一镜：${shotId}`)
    return s
  }

  current(shotId: string): ShotVersion {
    const s = this.state(shotId)
    const v = s.versions.find((x) => x.version === s.current)
    if (!v) throw new Error(`镜 ${shotId} 没有第 ${s.current} 版`)
    return v
  }

  private dialogueOf(shot: Shot): string {
    return shot.dialogue[0]?.text ?? ''
  }

  private voiceIdOf(shot: Shot): string {
    const cid = shot.dialogue[0]?.characterId
    return CAST.find((c) => c.id === cid)?.voiceId ?? 'male-qn-qingse'
  }

  /** 第一版：全量生成。之后每一版都只补做受影响的节点。 */
  async seed(): Promise<void> {
    for (const shot of draftShots()) {
      const dir = this.run.path('shots', shot.id, 'v1')
      await mkdir(dir, { recursive: true })
      const artifacts: Record<string, string> = {}
      artifacts[nodeId(shot.id, 'frame')] = `${dir}/first-frame.png`
      await this.providers.image.generate({
        prompt: `${shot.visual}，${shot.shotSize} 景别`,
        outPath: artifacts[nodeId(shot.id, 'frame')],
        aspectRatio: '9:16',
      })
      artifacts[nodeId(shot.id, 'clip')] = `${dir}/clip.mp4`
      await this.providers.video.generate({
        prompt: `${shot.visual}，${shot.camera}`,
        outPath: artifacts[nodeId(shot.id, 'clip')],
        durationSec: shot.durationSec,
        firstFrame: artifacts[nodeId(shot.id, 'frame')],
      })
      artifacts[nodeId(shot.id, 'voice')] = `${dir}/voice-1.mp3`
      await this.providers.tts.synthesize({
        text: this.dialogueOf(shot),
        voiceId: this.voiceIdOf(shot),
        outPath: artifacts[nodeId(shot.id, 'voice')],
      })
      this.shots.push({
        shot,
        status: 'ready',
        current: 1,
        versions: [
          {
            version: 1,
            at: new Date().toISOString(),
            dialogue: this.dialogueOf(shot),
            visual: shot.visual,
            artifacts,
            regenerated: Object.keys(artifacts),
            reason: '首次生成',
          },
        ],
      })
    }
    await this.writeTimeline()
    await this.save()
  }

  /** 改一个字段：只登记草稿并算出爆炸半径，**不生成任何东西**。生成要人再点一次。 */
  edit(shotId: string, field: EditableField, value: string): string[] {
    const affected = affectedNodes(
      this.shots.map((s) => s.shot),
      shotId,
      field
    )
    this.pending.set(shotId, { field, value, affected })
    return affected
  }

  /**
   * 重生成：只跑受影响的节点，其余产物**从上一版复制过来**。
   * 复制这一步很关键——它是「只重跑了受影响节点」的可验证证据：
   * 复制过来的文件哈希和上一版一模一样，重跑过的不一样。
   */
  async regenerate(shotId: string): Promise<ShotVersion> {
    const s = this.state(shotId)
    const draft = this.pending.get(shotId)
    if (!draft) throw new Error(`镜 ${shotId} 没有待生效的修改`)
    const prev = this.current(shotId)
    const shot = s.shot
    const dialogue = draft.field === 'dialogue' ? draft.value : prev.dialogue
    const visual = draft.field === 'visual' ? draft.value : prev.visual

    s.status = 'generating'
    const version = s.versions.length + 1
    const dir = this.run.path('shots', shotId, `v${version}`)
    await mkdir(dir, { recursive: true })

    const mine = draft.affected.filter((id) => id.startsWith(`${shotId}:`))
    const artifacts: Record<string, string> = {}
    const names: Record<string, string> = {
      frame: 'first-frame.png',
      clip: 'clip.mp4',
      voice: 'voice-1.mp3',
    }

    for (const kind of ['frame', 'clip', 'voice'] as const) {
      const id = nodeId(shotId, kind)
      const out = `${dir}/${names[kind]}`
      artifacts[id] = out
      // 练习 2：没受影响的节点要从上一版**复制**过来，一次接口都不该调。
      // 提示：用 copyFile(prev.artifacts[id], out) 然后 continue。
      //       自检第 4 项数的就是这次重生成到底调了几次图像 / 视频 / 语音接口。
      void mine
      void copyFile
      if (kind === 'frame')
        await this.providers.image.generate({
          prompt: `${visual}，${shot.shotSize} 景别`,
          outPath: out,
          aspectRatio: '9:16',
        })
      if (kind === 'clip')
        await this.providers.video.generate({
          prompt: `${visual}，${shot.camera}`,
          outPath: out,
          durationSec: shot.durationSec,
          firstFrame: artifacts[nodeId(shotId, 'frame')],
        })
      if (kind === 'voice')
        await this.providers.tts.synthesize({
          text: dialogue,
          voiceId: this.voiceIdOf(shot),
          outPath: out,
        })
    }

    const entry: ShotVersion = {
      version,
      at: new Date().toISOString(),
      dialogue,
      visual,
      artifacts,
      regenerated: draft.affected,
      reason: `人工修改 ${draft.field}`,
    }
    s.versions.push(entry)
    s.current = version
    s.status = 'ready'
    this.pending.delete(shotId)
    if (draft.affected.includes(TIMELINE_NODE)) await this.writeTimeline()
    await this.save()
    return entry
  }

  /** 回滚：把 current 指回旧版本，并重算时间轴。产物一个都不删，随时能再切回来。 */
  async rollback(shotId: string, version: number): Promise<ShotVersion> {
    const s = this.state(shotId)
    if (!s.versions.some((v) => v.version === version))
      throw new Error(`镜 ${shotId} 没有第 ${version} 版`)
    // 练习 3：回滚。把 current 指回旧版本，重算时间轴，落盘。
    // 提示：产物一个都不要删——回滚之后还要能再切回新版本对比。
    void version
    await this.save()
    return this.current(shotId)
  }

  /** 审核意见按结构化字段存，下一次自动化才能拿它当规则用（比如某个标签命中就自动打回）。 */
  async recordReview(note: Omit<ReviewNote, 'at'>): Promise<ReviewNote> {
    const full: ReviewNote = { ...note, at: new Date().toISOString() }
    // 练习 4：把审核意见按结构化字段存进 this.reviews 并落盘。
    // 提示：只打日志是不够的——下一次自动化要能读回这些标签当规则用，
    //       比如「连续两次 face-inconsistent 就别再自动重试了，直接叫人」。
    console.log('[review]', JSON.stringify(full))
    return full
  }

  private async writeTimeline(): Promise<void> {
    let cursor = 0
    const entries = this.shots.map((s) => {
      const v = this.current(s.shot.id)
      const startMs = cursor
      cursor += s.shot.durationSec * 1000
      return {
        shotId: s.shot.id,
        startMs,
        endMs: cursor,
        clipPath: v.artifacts[nodeId(s.shot.id, 'clip')],
        voicePath: v.artifacts[nodeId(s.shot.id, 'voice')],
        subtitle: v.dialogue,
      }
    })
    await writeJson(this.run.path('timeline', 'episode-1.json'), entries)
  }

  async save(): Promise<void> {
    await writeFile(
      this.run.path('review.json'),
      JSON.stringify({ runId: this.run.id, shots: this.shots, reviews: this.reviews }, null, 2),
      'utf8'
    )
  }

  /** 给页面用的视图：把当前版本、版本列表、草稿状态摊平成一个 JSON。 */
  view() {
    return {
      runId: this.run.id,
      shots: this.shots.map((s) => {
        const v = this.current(s.shot.id)
        const draft = this.pending.get(s.shot.id)
        return {
          id: s.shot.id,
          shotSize: s.shot.shotSize,
          durationSec: s.shot.durationSec,
          camera: s.shot.camera,
          status: s.status,
          current: s.current,
          dialogue: v.dialogue,
          visual: v.visual,
          versions: s.versions.map((x) => ({
            version: x.version,
            at: x.at,
            dialogue: x.dialogue,
            regenerated: x.regenerated,
            reason: x.reason,
          })),
          media: {
            frame: `/media/${v.artifacts[nodeId(s.shot.id, 'frame')]}`,
            clip: `/media/${v.artifacts[nodeId(s.shot.id, 'clip')]}`,
            voice: `/media/${v.artifacts[nodeId(s.shot.id, 'voice')]}`,
          },
          pending: draft
            ? { field: draft.field, value: draft.value, affected: draft.affected }
            : null,
        }
      }),
      reviews: this.reviews,
    }
  }
}
