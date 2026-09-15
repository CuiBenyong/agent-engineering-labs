// 写手角色：拼提示词、要 JSON、抠 JSON、过 schema。
// 校验不过就把带路径的问题原样喂回去让模型修一次——这一步比换更大的模型有用得多。

import type { Character, TextProvider } from './providers/index.js'
import { VOICE_IDS } from './voices.js'
import {
  extractJson,
  parseCharacters,
  parseEpisode,
  parseWorld,
  type Episode,
  type Issue,
  type World,
} from './schema.js'

const SYSTEM = `你是竖屏短剧编剧。你的输出会被程序直接消费，所以只输出 JSON，不要任何解释文字。
景别只能是 wide / medium / close。每镜时长 3 到 8 秒，全集总时长 45 到 90 秒。
单条台词不超过 25 字。每个分镜都要写 camera 运镜描述。`

function issueLines(issues: Issue[]): string {
  return issues.map((i) => `- ${i.path}：${i.message}`).join('\n')
}

/** 一次「要 JSON 并校验」的通用流程：不过就带着问题重来一次。 */
async function ask<T>(
  text: TextProvider,
  system: string,
  user: string,
  parse: (v: unknown, out: Issue[]) => T
): Promise<T> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const raw = await text.complete({ system, user, temperature: 0.8 })
    const issues: Issue[] = []
    let value: T
    try {
      value = parse(extractJson(raw.text), issues)
    } catch (err) {
      issues.push({ path: '(整体)', message: err instanceof Error ? err.message : String(err) })
      value = undefined as unknown as T
    }
    if (issues.length === 0) return value
    if (attempt === 2) throw new Error(`schema 校验两次都没过：\n${issueLines(issues)}`)
    console.log(`    schema 不过 ${issues.length} 处，带着问题重来一次`)
    user = `${user}\n\n上一版有这些字段问题，请只修这些，别改别的：\n${issueLines(issues)}`
  }
  throw new Error('unreachable')
}

export async function draftWorld(text: TextProvider, idea: string): Promise<World> {
  return ask(
    text,
    SYSTEM,
    `一句话：${idea}\n请输出世界观档案 JSON，字段：title、logline、tone、setting、rules（字符串数组，至少 1 条）。`,
    parseWorld
  )
}

export async function draftCharacters(
  text: TextProvider,
  idea: string,
  world: World
): Promise<Character[]> {
  return ask(
    text,
    SYSTEM,
    `一句话：${idea}\n世界观：${world.logline}\n请输出人物卡 JSON 数组，至少 2 个，字段：id（形如 c1）、name、appearance、personality、voiceId。\nvoiceId 必须从下面这份清单里挑，不要自己编：${VOICE_IDS.join('、')}`,
    (v, out) => parseCharacters(v, out)
  )
}

export async function draftEpisode(
  text: TextProvider,
  input: { idea: string; world: World; characters: Character[]; feedback: string[] }
): Promise<Episode> {
  const roster = input.characters.map((c) => `${c.id} ${c.name}（${c.personality}）`).join('，')
  const base = `一句话：${input.idea}\n世界观：${input.world.logline}\n人物：${roster}
请输出这一集的分镜 JSON，字段：episode、title、scenes（id 形如 sc1、name、description）、shots（id 形如 s01、sceneId 引用上面的场景 id、shotSize、durationSec、characters 引用人物 id、visual、camera、dialogue）。`
  const user =
    input.feedback.length === 0
      ? base
      : `${base}\n\n评审意见：\n${input.feedback.map((f) => `- ${f}`).join('\n')}`
  return ask(text, SYSTEM, user, (v, out) => parseEpisode(v, input.characters, out))
}
