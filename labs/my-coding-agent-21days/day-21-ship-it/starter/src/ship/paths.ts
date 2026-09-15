/**
 * 三个根目录。本天新增，也是本天最底下那块砖。
 *
 * 前二十天 mca 只在 lab 目录里跑，于是「包在哪」「项目在哪」「用户配置在哪」
 * 是同一个地方，`process.cwd()` 一个函数就够了。今天它要被装到别人机器上、
 * 在别人的仓库里启动，这三件事第一次分开：
 *
 *   包根      代码与随包分发的资产在哪（全局安装后在 npm 的前缀里，和用户八竿子打不着）
 *   项目根    用户此刻在哪个仓库里干活（cwd 或它往上第一个带 .mca 的目录）
 *   用户目录  这台机器上属于这个人的偏好（~/.mca）
 *
 * **凡是随包分发的东西一律从包根找，凡是用户的东西一律不从包根找。** 这条一破，
 * 症状是「我自己跑没问题，别人装了之后找不到文件」——而且本地永远复现不出来，
 * 因为本地这三个根恰好是同一个目录。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

/**
 * 包根：从本文件出发**向上找第一个带 package.json 的目录**。
 *
 * 为什么不写死 `path.resolve(here, '../..')`：源码在 src/ship/ 下，编译产物在
 * dist/ship/ 下，两者的层级今天恰好一样，明天换个构建配置就不一样了。
 * 向上找是对「我被放在哪儿」这件事唯一不做假设的写法。
 */
export function packageRoot(start: string = here): string {
  let dir = start
  for (;;) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return start
    dir = parent
  }
}

/** 用户目录：~/.mca。MCA_HOME 可以改写它，自检与临时前缀验证都靠这个开关 */
export function userConfigDir(): string {
  const override = process.env.MCA_HOME
  if (override) return path.resolve(override)
  return path.join(os.homedir(), '.mca')
}

/**
 * 项目根：从 cwd 向上找第一个带 .mca 目录的祖先，找不到就是 cwd 本身。
 *
 * 向上找是因为人经常在子目录里敲命令（`cd packages/web` 之后再 `mca`），
 * 而项目级配置显然该属于整个仓库。停在第一个命中的祖先、不继续往上翻，
 * 是为了让嵌套仓库有一个确定答案：**离你最近的那份配置赢。**
 */
export function projectRoot(start: string = process.cwd()): string {
  let dir = path.resolve(start)
  for (;;) {
    if (fs.existsSync(path.join(dir, '.mca'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return path.resolve(start)
    dir = parent
  }
}

export function projectConfigDir(start?: string): string {
  return path.join(projectRoot(start), '.mca')
}
