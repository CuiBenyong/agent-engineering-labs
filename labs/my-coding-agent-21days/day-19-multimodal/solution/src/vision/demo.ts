/**
 * 今天的演示素材：三张图片与一个带界面文案的源文件。本天新增。
 *
 * **仓库里一个二进制文件都没有。** 图片是跑的时候现生成的（png.ts），
 * 跟沙盒仓库一样落在 work/ 下，清掉就干净。这样做的第二个好处是
 * 「4x4 那张为什么是 4x4」在代码里一目了然，而不是躺在一个谁也打不开的文件里。
 *
 * 生成的四样东西各有各的用处：
 *   ui.png              640x400，合法，今天的主角——照着它改文案
 *   ui-tiny.png         4x4，短边不到 64，被拦下（实测下限就在这附近）
 *   screenshot.jpg      **内容是 PNG，名字叫 .jpg** —— 嗅探器按字节判，不按名字判
 *   work/repo/src/ui.js 沙盒仓库里的界面文案，模型照着图把它改掉
 *
 * seed.ts 是全课冻结文件，不能往里加东西，所以界面文案这个文件由本天自己补。
 * 顺序也因此是死的：**先 seedRepo 再 seedDemoShots**，反过来会被沙盒仓库的重建冲掉。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { encodePng, solidPng, type Rgb } from './png.js'
import { REPO_DIR } from '../seed.js'

export const SHOTS_DIR = path.resolve(process.cwd(), 'work/shots')

/** 沙盒仓库里那份界面文案。模型今天要改的就是它 */
export const UI_FILE = 'src/ui.js'

const UI_SOURCE = `// 工具栏的按钮文案。改文案只改这里
export const LABELS = {
  submit: '提交',
  cancel: '取消',
}

export function toolbar() {
  return [LABELS.submit, LABELS.cancel].join(' | ')
}
`

/**
 * 一张「界面截图」的占位图：顶上一条深色标题栏，中间一块主按钮，其余是浅色背景，
 * 再叠一层幅度很小的确定性噪点。
 *
 * 噪点不是为了好看，是为了**让这张图的体积像一张真截图**。纯色块图 deflate 之后
 * 只有两百来字节，拿它去演示「图片很贵」会得出一个完全相反的结论。噪点由坐标算出来、
 * 不用随机数，所以同一台机器上连跑两次生成的字节完全一样——今天的数字才敢说可复现。
 *
 * 它当然不是真的界面截图——**我们没有字体，画不出字。** 这一点正文里也写明了：
 * 离线模式下「模型看到了什么」是剧本写死的，可复现的是链路本身（校验、编码、
 * 消息结构、报账、降级），不是模型的视力。想看真的，把你自己的截图存成
 * work/shots/ui.png，去掉 MOCK=1 再跑一次。
 */
export const UI_WIDTH = 640
export const UI_HEIGHT = 400

/** 一个只看坐标的整数散列。同样的坐标永远得到同样的噪点 */
function jitter(x: number, y: number): number {
  const h = Math.imul(x + 1, 374761393) ^ Math.imul(y + 1, 668265263)
  return ((h >>> 3) % 7) - 3
}

function uiMock(x: number, y: number): Rgb {
  const base: Rgb =
    y < 52
      ? [38, 42, 54] // 标题栏
      : y >= 180 && y < 244 && x >= 80 && x < 400
        ? [46, 128, 210] // 主按钮
        : [238, 240, 244] // 背景
  const d = jitter(x, y)
  return [clamp(base[0] + d), clamp(base[1] + d), clamp(base[2] + d)]
}

function clamp(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v
}

export interface DemoShots {
  files: string[]
}

export async function seedDemoShots(): Promise<DemoShots> {
  await fs.mkdir(SHOTS_DIR, { recursive: true })

  const ui = encodePng(UI_WIDTH, UI_HEIGHT, uiMock)
  await fs.writeFile(path.join(SHOTS_DIR, 'ui.png'), ui)
  // 短边 4 像素：实测这个量级的图会被模型判成无效图片，本地那道下限闸就是为它准备的
  await fs.writeFile(path.join(SHOTS_DIR, 'ui-tiny.png'), solidPng(4, 4, [200, 40, 40]))
  // 名字是 .jpg，字节是 PNG。嗅探器该说出「这是 image/png」
  await fs.writeFile(path.join(SHOTS_DIR, 'screenshot.jpg'), ui)

  await fs.mkdir(path.join(REPO_DIR, 'src'), { recursive: true })
  await fs.writeFile(path.join(REPO_DIR, UI_FILE), UI_SOURCE, 'utf8')

  return {
    files: [
      'work/shots/ui.png',
      'work/shots/ui-tiny.png',
      'work/shots/screenshot.jpg',
      `work/repo/${UI_FILE}`,
    ],
  }
}
