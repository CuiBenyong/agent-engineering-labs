/**
 * 图片的合法性校验。本天新增。
 *
 * **这几条线全是我们自己定的本地策略，不是任何一家网关的上限。** 各家对图片大小、
 * 边长、张数的限制都不一样，而且会变；代码里写死一个别家的数字，等于给自己埋一个
 * 会在某天悄悄过期的假事实。所以这里只写「我们愿意发出去的东西长什么样」，
 * 真实上限一律以你所用网关的文档为准。
 *
 * 只有一条线有实测来源：**边长下限。** 2026-09-07 用真实 key 实测过，一张 4x4 的 PNG
 * 被判 unsupported image，64x64 的同一张图正常——**所以小图是真的会被拒，而不是我们多心。**
 * 把它挡在本地，读者拿到的是一句人话；发出去再被拒，拿到的是一条网关错误码。
 *
 * 为什么校验要放在客户端而不是"发出去让对面判"：
 *   1. 一张图动辄几百 KB，发出去再被拒是白花的往返与流量；
 *   2. 对面的拒绝理由往往只有一个错误码，人看不懂；
 *   3. 最要命的一条——**有些模型不会拒绝，它会编一个答案**（见 capability.ts）。
 *      能自己判的事就别指望对面替你判。
 */
import type { ImageInfo } from './probe.js'

/** 支持清单是白名单：认得出的格式也未必收 */
export const SUPPORTED_TYPES = ['image/png', 'image/jpeg']

/** 边长下限。实测依据见文件头 */
export const MIN_SIDE = 64
/** 单张体积上限（本地策略） */
export const MAX_IMAGE_BYTES = 3 * 1024 * 1024
/** 一轮最多几张（本地策略） */
export const MAX_IMAGES_PER_TURN = 4
/** 一轮的图片总字节预算（本地策略） */
export const TURN_IMAGE_BYTES = 6 * 1024 * 1024

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

/**
 * 校验一张图。通过返回 null，不通过返回**一句人话**。
 *
 * 提示词里三样东西缺一不可：哪里不合格、合格线是多少、下一步该干什么。
 * 只说「图片不合法」的提示等于没说——用户不知道是换一张、压一下，还是这条路根本走不通。
 */
export function validateImage(info: ImageInfo): string | null {
  if (!SUPPORTED_TYPES.includes(info.mediaType)) {
    return `这是 ${info.mediaType}，本工具只收 ${SUPPORTED_TYPES.join(' 与 ')}。先转成 PNG 再贴进来。`
  }
  // TODO(2)：加上边长下限那道闸。短边不足 MIN_SIDE 就返回一句人话，说清
  //   ① 这张图多大  ② 合格线是多少  ③ 下一步该干什么。
  // 三样缺一样，用户就只能猜自己该换图还是该放弃。
  if (info.bytes > MAX_IMAGE_BYTES) {
    return (
      `这张图 ${formatBytes(info.bytes)}，超过单张上限 ${formatBytes(MAX_IMAGE_BYTES)}。` +
      `先在本地压一下再贴——截图里真正有信息的通常只有一小块，裁掉周边比压画质划算。`
    )
  }
  return null
}

/** 一轮的两条总量闸。张数与总字节各管一头，触发哪条就说哪条 */
export function validateTurn(accepted: ImageInfo[], next: ImageInfo): string | null {
  if (accepted.length >= MAX_IMAGES_PER_TURN) {
    return `一轮最多带 ${MAX_IMAGES_PER_TURN} 张图，这张被丢下了。分成几轮说，模型也看得更清楚。`
  }
  const total = accepted.reduce((sum, info) => sum + info.bytes, 0) + next.bytes
  if (total > TURN_IMAGE_BYTES) {
    return (
      `这一轮的图片总量会到 ${formatBytes(total)}，超过单轮预算 ${formatBytes(TURN_IMAGE_BYTES)}。` +
      `先压缩或减少张数。`
    )
  }
  return null
}
