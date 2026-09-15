/**
 * 图片的格式嗅探与尺寸解析。本天新增。
 *
 * 一条口径贯穿整个文件：**看字节，不看扩展名。**
 *
 * 扩展名是用户随手打出来的（截图工具存成 .jpg、其实是 PNG，是很常见的一件事），
 * 而我们要把 mediaType 写进发给网关的报文里——写错了对面要么报一个看不懂的错，
 * 要么干脆当成坏数据丢掉。字节头（魔数）是文件自己带的，它才是事实。
 *
 * 三种格式的魔数与尺寸在哪，按需要读到哪：
 *   PNG   89 50 4E 47 0D 0A 1A 0A，宽高是 IHDR 的头八个字节，大端，偏移固定 16 与 20
 *   JPEG  FF D8 FF 开头，宽高要**沿着 marker 一段段走**到 SOFn 那一段才有
 *   GIF   GIF87a / GIF89a，宽高在偏移 6 与 8，小端两字节
 *
 * GIF 认得出来但不在支持清单里（见 validate.ts）。认得出来还要拒绝，比"不认识"强：
 * 前者能告诉用户「这是 GIF，本工具只收 PNG 与 JPEG」，后者只能说「看不懂」。
 */

export interface ImageInfo {
  mediaType: string
  width: number
  height: number
  bytes: number
}

export type ProbeResult = { ok: true; info: ImageInfo } | { ok: false; problem: string }

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** 只判格式，不解尺寸。认不出来返回 null */
export function sniffMediaType(buf: Buffer): string | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIGNATURE)) return 'image/png'
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (buf.length >= 6 && buf.subarray(0, 3).toString('ascii') === 'GIF') return 'image/gif'
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp'
  }
  return null
}

export function probeImage(buf: Buffer): ProbeResult {
  const mediaType = sniffMediaType(buf)
  if (!mediaType) {
    const head = [...buf.subarray(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join(' ')
    return {
      ok: false,
      problem: `看不出这是什么图片格式（头四个字节是 ${head || '空'}）。本工具按字节头判断格式，不看扩展名。`,
    }
  }

  const size =
    mediaType === 'image/png'
      ? pngSize(buf)
      : mediaType === 'image/jpeg'
        ? jpegSize(buf)
        : mediaType === 'image/gif'
          ? gifSize(buf)
          : null

  if (!size) {
    // 认得出格式但读不出尺寸：不猜一个默认值蒙混过去。尺寸下限那道闸要靠它，
    // 一旦这里返回一个编出来的数，下限检查就成了摆设
    return { ok: false, problem: `识别为 ${mediaType}，但读不出宽高，无法做尺寸检查。` }
  }
  return {
    ok: true,
    info: { mediaType, width: size.width, height: size.height, bytes: buf.length },
  }
}

function pngSize(buf: Buffer): { width: number; height: number } | null {
  // IHDR 必须是第一个块，所以宽高的偏移是固定的：8 签名 + 4 长度 + 4 类型 = 16
  if (buf.length < 24) return null
  if (buf.subarray(12, 16).toString('ascii') !== 'IHDR') return null
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

function gifSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 10) return null
  return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) }
}

/**
 * JPEG 没有固定偏移，只能沿着 marker 走。
 *
 * 规则：每个 marker 是 FF 加一个字节；D8（开始）、D9（结束）与 D0–D7（重启）**不带长度**，
 * 其余都带两字节大端长度。走到 SOFn 那一段，里面第 1 字节是精度、接着两字节高、两字节宽。
 *
 * 要跳过的是 C4（霍夫曼表）、C8、CC 这三个：它们的编号落在 SOF 的区间里，却不是 SOF。
 * 漏了这条判断，遇到带霍夫曼表的图就会把表里的字节当成宽高读出来——而它**不会报错**，
 * 只会给你一个离谱的尺寸。
 */
function jpegSize(_buf: Buffer): { width: number; height: number } | null {
  // TODO(1)：沿着 marker 走到 SOFn，读出宽高。
  //
  //   - 每个 marker 是 FF 加一个字节；D8、D9 与 D0–D7 **不带长度**，其余都带两字节大端长度
  //   - SOFn 的编号在 C0–CF 之间，但要跳过 C4（霍夫曼表）、C8、CC —— 它们编号在区间里却不是 SOF
  //   - 命中 SOF 之后：第 1 字节是精度，接着两字节高、两字节宽，都是大端
  //
  // 漏了那条跳过判断的后果是最值得记住的一点：**它不会报错**，只会把霍夫曼表里的
  // 字节当成宽高读出来，给你一个离谱但看起来很正常的尺寸。
  return null
}
