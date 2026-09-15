// D3 实验（starter）：从人物卡批量产出定妆图与场景资产，并建一个会去重的资产库。
// 四个练习点分布在 assets.ts（练习 1、2）与本文件（练习 3、4）。
// 先原样跑一次 MOCK=1 pnpm start，把报告最后三行的数字记下来，再逐个动手。
// 当天要看到的三个现象：
//   1. 每个角色先出一张基准图，再由它派生出多张变体（派生时带参考图）
//   2. 同样的描述第二次不再生成，日志打印「复用」
//   3. 关掉参考图跑同一组派生，两组指纹并排列出来，证明参考图真的进了这次请求

import 'dotenv/config'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { ensureFfmpeg } from './ffmpeg.js'
import {
  createProviders,
  isMock,
  type Character,
  type Shot,
  type Scene,
} from './providers/index.js'
import { warnIfPaidOutputInRepo, Run, newRunId, writeJson } from './run.js'
import { AssetLibrary, assetKey, type AssetKind, type AssetRecord } from './assets.js'

/** 固定的风格模板：全课每一张图都拼上它，这是「三种锁人手段」里最便宜的一种。 */
const STYLE = '国产都市短剧质感，柔和影棚布光，浅景深，写实人像，竖屏构图，无文字水印'

/** 角色定妆要派生的变体。基准图之外的每一张都会带上参考图。 */
const VARIANTS = [
  { name: 'front', desc: '正面证件照式半身，平视机位，中性表情' },
  { name: 'side', desc: '侧面四分之三角度半身，视线看向画面外' },
  { name: 'angry', desc: '正面半身，眉头紧锁的愤怒表情' },
]

// ---------- D2 的产物：本天直接内置一份，真实流程里由剧本 Agent 写出 ----------

function draftCharacters(): Character[] {
  return [
    {
      id: 'c1',
      name: '林野',
      appearance: '二十五岁男性，短寸黑发，浓眉，左眉尾一道浅疤，蓝色外卖工服，胸前印白色编号',
      personality: '嘴硬心软',
      voiceId: 'junlang_nanyou',
    },
    {
      id: 'c2',
      name: '苏晓',
      appearance: '二十三岁女性，黑色长直发，圆框眼镜，米色针织衫外搭卡其风衣',
      personality: '冷静敏锐',
      voiceId: 'danya_xuejie',
    },
  ]
}

function draftScenes(): Scene[] {
  return [
    {
      id: 'sc1',
      name: '雨夜居民楼下',
      description: '老旧居民楼楼下，雨夜，电动车停成一排，路灯昏黄',
    },
    {
      id: 'sc2',
      name: '便利店门口',
      description: '深夜便利店门口，冷白灯箱，玻璃门上贴着促销海报',
    },
  ]
}

function draftShots(): Shot[] {
  return [
    {
      id: 's01',
      sceneId: 'sc1',
      shotSize: 'wide',
      durationSec: 6,
      characters: ['c1'],
      visual: '男主蹲在电动车旁，手里握着一部亮着屏的手机',
      camera: '缓慢推近',
      dialogue: [{ characterId: 'c1', text: '这手机怎么自己亮了' }],
    },
    {
      id: 's02',
      sceneId: 'sc1',
      shotSize: 'close',
      durationSec: 6,
      characters: ['c1'],
      visual: '手机屏幕特写，显示着五分钟后的新闻推送',
      camera: '固定机位',
      dialogue: [{ characterId: 'c1', text: '五分钟后？这不可能' }],
    },
    {
      id: 's03',
      sceneId: 'sc2',
      shotSize: 'medium',
      durationSec: 6,
      characters: ['c1', 'c2'],
      visual: '女主拦下正要离开的男主，两人隔着半步距离对视',
      camera: '横移跟拍',
      dialogue: [{ characterId: 'c2', text: '那部手机，不是你的' }],
    },
  ]
}

// ---------- 提示词拼装：结构固定，变量只在描述那一段 ----------

function characterPrompt(c: Character, variantDesc: string): string {
  // 练习 3：把「外貌描述 + 本次变体描述 + 固定风格模板」三段拼成一条提示词。
  // 提示：默认实现只有外貌，于是六个变体的提示词一模一样，模型不知道你要正面还是侧面，
  //       风格也每张随机漂一次——这正是「提示词模板」这一手段要解决的问题。
  void variantDesc
  void STYLE
  return c.appearance
}

function scenePrompt(s: Scene): string {
  return `${s.description}，空镜，无人物出现。${STYLE}`
}

/** 文件指纹：真实接口下你靠肉眼比脸，离线模式下靠它证明两次请求确实不同。 */
async function fingerprint(path: string): Promise<string> {
  return createHash('sha1')
    .update(await readFile(path))
    .digest('hex')
    .slice(0, 10)
}

// ---------- 带去重的生成入口：整个实验只有这一个地方会调图像接口 ----------

type Providers = ReturnType<typeof createProviders>

async function ensureAsset(
  providers: Providers,
  run: Run,
  lib: AssetLibrary,
  input: {
    kind: AssetKind
    ownerId: string
    variant: string
    prompt: string
    outPath: string
    referenceImage?: string
    seed?: number
  }
): Promise<AssetRecord> {
  const id = assetKey(input)
  const cached = lib.find(id)
  if (cached) {
    lib.hits += 1
    console.log(`    ↺ 复用 ${id}  ${cached.path}`)
    return cached
  }

  lib.misses += 1
  // 练习 4：把 seed 与 referenceImage 一起传给图像接口。
  // 提示：默认实现只传了提示词，于是第 5 步的对照表会全部显示「相同」——
  //       两组图完全一样，恰恰说明参考图根本没进请求。
  //       接口侧对应的是 subject_reference，每次请求只能带一张，type 只支持 character。
  const r = await providers.image.generate({
    prompt: input.prompt,
    outPath: input.outPath,
    aspectRatio: '9:16',
  })
  run.record({
    nodeId: `assets:${input.kind}`,
    provider: providers.image.name as 'mock' | 'minimax',
    kind: 'image',
    model: providers.image.model,
    units: 1,
    costCny: r.costCny,
    cached: false,
  })
  const record: AssetRecord = {
    id,
    kind: input.kind,
    ownerId: input.ownerId,
    variant: input.variant,
    prompt: input.prompt,
    path: r.path,
    referenceImage: input.referenceImage,
    seed: input.seed,
    costCny: r.costCny,
    at: new Date().toISOString(),
  }
  lib.register(record)
  console.log(`    ＋ 生成 ${id}  ${r.path}${input.referenceImage ? '  （带参考图）' : ''}`)
  return record
}

async function main() {
  warnIfPaidOutputInRepo()
  await ensureFfmpeg()

  const providers = createProviders()
  const run = new Run(newRunId())
  await run.init()
  const lib = new AssetLibrary(run.path('assets', 'index.json'))
  await lib.load()

  const characters = draftCharacters()
  const scenes = draftScenes()
  const shots = draftShots()

  console.log(
    `模式：${isMock() ? 'MOCK 离线占位' : `真实厂商 ${providers.image.name} / ${providers.image.model}`}`
  )
  console.log(`产物目录：${run.dir}\n`)
  await writeJson(run.path('script', 'characters.json'), characters)
  await writeJson(run.path('script', 'episode-1.json'), { scenes, shots })

  // 1. 定妆：每个角色一张基准图。不带参考图（此时还没有），但带固定 seed。
  console.log('▸ 1/5 角色基准定妆图')
  for (const c of characters) {
    const prompt = characterPrompt(c, '正面半身定妆照，中性表情，纯灰色背景')
    const rec = await ensureAsset(providers, run, lib, {
      kind: 'character',
      ownerId: c.id,
      variant: 'base',
      prompt,
      outPath: run.path('assets', 'characters', c.id, 'base.png'),
      seed: 20260907,
    })
    // 基准图选定后写回人物卡，后面所有天（首帧、镜头）都读这个字段。
    c.referenceImage = rec.path
  }

  // 2. 派生：以基准图为参考图生成多角度多表情。
  console.log('\n▸ 2/5 由基准图派生变体（带参考图）')
  const withRef = new Map<string, string>()
  for (const c of characters) {
    for (const v of VARIANTS) {
      const rec = await ensureAsset(providers, run, lib, {
        kind: 'character',
        ownerId: c.id,
        variant: v.name,
        prompt: characterPrompt(c, v.desc),
        outPath: run.path('assets', 'characters', c.id, `${v.name}.png`),
        referenceImage: c.referenceImage,
        seed: 20260907,
      })
      withRef.set(`${c.id}/${v.name}`, await fingerprint(rec.path))
    }
  }

  // 3. 场景与道具：反复出现的东西提前生成并登记，镜头阶段直接取。
  console.log('\n▸ 3/5 场景资产')
  const usedScenes = scenes.filter((s) => shots.some((sh) => sh.sceneId === s.id))
  for (const s of usedScenes) {
    await ensureAsset(providers, run, lib, {
      kind: 'scene',
      ownerId: s.id,
      variant: 'base',
      prompt: scenePrompt(s),
      outPath: run.path('assets', 'scenes', `${s.id}.png`),
      seed: 20260907,
    })
  }

  // 4. 去重：把第 3 步原样再跑一遍，一张都不该重新生成。
  console.log('\n▸ 4/5 同一批场景再跑一遍（验证去重）')
  const before = lib.misses
  for (const s of usedScenes) {
    await ensureAsset(providers, run, lib, {
      kind: 'scene',
      ownerId: s.id,
      variant: 'base',
      prompt: scenePrompt(s),
      outPath: run.path('assets', 'scenes', `${s.id}.png`),
      seed: 20260907,
    })
  }
  const regenerated = lib.misses - before

  // 5. 对照组：同样的提示词与 seed，唯一的差别是不传参考图。
  console.log('\n▸ 5/5 关掉参考图跑同一组派生（对照组）')
  const noRef = new Map<string, string>()
  for (const c of characters) {
    for (const v of VARIANTS) {
      const rec = await ensureAsset(providers, run, lib, {
        kind: 'character',
        ownerId: c.id,
        variant: `noref-${v.name}`,
        prompt: characterPrompt(c, v.desc),
        outPath: run.path('assets', 'characters', c.id, `noref-${v.name}.png`),
        seed: 20260907,
      })
      noRef.set(`${c.id}/${v.name}`, await fingerprint(rec.path))
    }
  }

  await lib.save()
  await writeJson(run.path('script', 'characters.json'), characters)
  await run.save({ assets: lib.list().length, cacheHits: lib.hits })
  report(lib, regenerated, withRef, noRef)
}

function report(
  lib: AssetLibrary,
  regenerated: number,
  withRef: Map<string, string>,
  noRef: Map<string, string>
) {
  console.log('\n对照表（同提示词、同 seed，只差一个参考图）：')
  console.log('  变体            带参考图    无参考图    是否相同')
  let differing = 0
  for (const [key, a] of withRef) {
    const b = noRef.get(key) ?? '-'
    const same = a === b
    if (!same) differing += 1
    console.log(`  ${key.padEnd(14)}  ${a}  ${b}  ${same ? '相同' : '不同'}`)
  }

  console.log('\n资产库：')
  console.log(
    `  登记 ${lib.list().length} 件，本次新生成 ${lib.misses} 次，命中复用 ${lib.hits} 次`
  )
  console.log(`  第 4 步重复请求的场景重新生成了 ${regenerated} 张（应为 0）`)
  console.log(`  对照组里 ${differing}/${withRef.size} 个变体与带参考图的结果不同`)
  if (isMock()) {
    console.log('\n离线模式下指纹不同只能证明「参考图确实进了这次请求」；')
    console.log('接上真实 key 之后，请把两组图并排打开，用眼睛判断哪一组还是同一个人。')
  } else {
    // 真实模式下这一步的结论只能靠眼睛：像素哈希不同是必然的，一致性是主观判断。
    console.log('\n两组图都已落盘。现在把它们并排打开，用眼睛判断哪一组还是同一个人——')
    console.log('这一步没有自动化的替代品，像素哈希不同是必然的，一致性只能人看。')
  }
}

main().catch((err: unknown) => {
  console.error(`\n失败：${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
})
