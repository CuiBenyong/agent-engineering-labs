/**
 * 一个能写出合法 PNG 的最小编码器。本天新增。
 *
 * 为什么课程里要自己写这个：演示素材得随实验分发，而**往教学仓库里塞二进制图片是个坏习惯**
 * （改一次多一份，谁都看不出改了什么）。所以这里不放图片，放一段能生成图片的代码——
 * 跑一次 seed 就有图，清掉 work/ 就干净。
 *
 * 它同时也是今天那个解析器的对照面：**你亲手拼过 PNG 的字节，才知道嗅探器为什么要读那几个偏移。**
 *
 * PNG 的结构只有四样东西：
 *   1. 八字节固定签名 89 50 4E 47 0D 0A 1A 0A
 *   2. 一串块，每块是「长度(4) + 类型(4) + 数据 + CRC32(4)」，长度与 CRC 都是大端
 *   3. 必须的头块 IHDR：宽、高、位深、颜色类型、压缩、滤波、隔行
 *   4. 像素数据块 IDAT：每行前面加一个滤波字节，整段用 zlib 压
 *
 * zlib 用 Node 内置的 node:zlib，CRC32 自己算——**它们都不是依赖**，本课零运行时依赖的
 * 规矩在这里一样管用。
 */
import zlib from 'node:zlib'

export type Rgb = [number, number, number]

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** CRC32 查表。标准多项式的反射形式 0xedb88320，算一次存下来 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (const byte of buf) c = (CRC_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** 一个块：长度、类型、数据、CRC。CRC 算的是「类型 + 数据」，不含长度那四个字节 */
function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([length, body, crc])
}

/**
 * 按一个「给我坐标、我告诉你颜色」的函数画一张真彩色 PNG。
 *
 * 颜色类型固定 2（每像素三字节 RGB）、位深 8、不隔行：这是最容易拼对的一种组合，
 * 也是嗅探器那边最容易读对的一种。课程要的是「一张合法的、尺寸可控的图」，不是图像库。
 */
export function encodePng(
  width: number,
  height: number,
  at: (x: number, y: number) => Rgb
): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // 位深
  ihdr[9] = 2 // 颜色类型：truecolor
  ihdr[10] = 0 // 压缩方法：只有 deflate 这一种
  ihdr[11] = 0 // 滤波方法：只有这一种
  ihdr[12] = 0 // 隔行：不隔行

  // 每一行前面要有一个滤波字节。这里一律用 0（不滤波）——滤波是为了压缩率，
  // 而我们生成的是几十乘几十的色块图，压缩率不重要，正确性重要
  const raw = Buffer.alloc(height * (1 + width * 3))
  let offset = 0
  for (let y = 0; y < height; y += 1) {
    raw[offset] = 0
    offset += 1
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = at(x, y)
      raw[offset] = r
      raw[offset + 1] = g
      raw[offset + 2] = b
      offset += 3
    }
  }

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** 纯色图。能力探测那张探针图就是它：颜色由我们指定，所以答案我们已知 */
export function solidPng(width: number, height: number, rgb: Rgb): Buffer {
  return encodePng(width, height, () => rgb)
}
