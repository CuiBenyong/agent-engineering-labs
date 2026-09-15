/**
 * 本天新增的一条斜杠命令：/vision。
 *
 * 它是这一天的「账本」。图片是上下文里最贵也最不透明的一类输入：用户看不见它折成了
 * 多少字节、看不见哪几张被拦下了、更看不见此刻这个模型到底能不能看见图。
 * 三件事都得有一个地方能问出来，否则出了问题只能靠猜。
 *
 *   /vision         看状态与上限
 *   /vision probe   现在就探一次（真实模式下会真的发一张探针图出去）
 *   /vision off     强制走文字降级（明知模型看不见时省掉那次探测与那份流量）
 *   /vision auto    回到自动
 */
import type { Command } from '../commands.js'
import { createProvider } from '../providers/index.js'
import { describeVision, probeVision, PROBE_QUESTION } from './capability.js'
import {
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_TURN,
  MIN_SIDE,
  SUPPORTED_TYPES,
  TURN_IMAGE_BYTES,
  formatBytes,
} from './validate.js'

export const VISION_COMMANDS: Command[] = [
  {
    name: 'vision',
    help: '看图片输入的状态与上限（probe 探一次 / off 强制文字降级 / auto 回到自动）',
    run: async (args, session) => {
      const arg = args.trim().toLowerCase()
      if (arg === 'off' || arg === 'auto') {
        session.vision.mode = arg
        session.out(`  已切到 ${arg}。${describeVision(session.vision)}`)
        return true
      }
      if (arg === 'probe') {
        const outcome = await probeVision(createProvider())
        session.vision.support = outcome.ok ? 'yes' : 'no'
        session.vision.note = outcome.note
        session.out(`  探针问的是：${PROBE_QUESTION}`)
        session.out(`  ${outcome.ok ? '✔' : '✘'} ${outcome.note}`)
        return true
      }
      session.out(`  ${describeVision(session.vision)}`)
      session.out(`  收的格式  ${SUPPORTED_TYPES.join('、')}（按字节头判断，不看扩展名）`)
      session.out(`  边长下限  ${MIN_SIDE} 像素（短边），实测更小的图会被模型判成无效图片`)
      session.out(`  单张上限  ${formatBytes(MAX_IMAGE_BYTES)}`)
      session.out(
        `  单轮上限  ${MAX_IMAGES_PER_TURN} 张 / ${formatBytes(TURN_IMAGE_BYTES)}（都是本地策略，不是网关的上限）`
      )
      session.out('  以上三条数字是我们自己定的；网关侧的真实上限以它的文档为准')
      return true
    },
  },
]
