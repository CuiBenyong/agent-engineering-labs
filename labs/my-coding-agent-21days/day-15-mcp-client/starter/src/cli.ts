/**
 * 命令行参数。本天新增——今天是第一次有「启动时就要做的选择」。
 *
 * 只认三个开关，故意不引 commander 之类的库：本课的卖点是自己实现，
 * 而斜杠命令与命令行参数的解析加起来还不到五十行。
 *
 *   --resume            接着最近那个会话
 *   --resume=<id>       接着指定会话（也支持 --resume <id>）
 *   --sessions          只列出会话然后退出
 *
 * 一条口径：**resume 不带 id 时取「最近一个」，而不是「上一个进程用的那个」。**
 * 后者要额外维护一个「当前会话」指针，而那个指针一旦和实际文件不一致，
 * 表现是「resume 到了一个空会话」，很难查。会话 id 里带时间，排序即最近。
 */

export interface CliOptions {
  /** true 表示「最近一个」，字符串表示指定 id */
  resume?: string | true
  sessions?: boolean
}

export function parseArgv(argv: string[]): CliOptions {
  const options: CliOptions = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string
    if (arg === '--sessions') {
      options.sessions = true
      continue
    }
    if (arg.startsWith('--resume=')) {
      options.resume = arg.slice('--resume='.length) || true
      continue
    }
    if (arg === '--resume') {
      const next = argv[i + 1]
      // 下一个参数不是开关就当成会话 id
      if (next && !next.startsWith('--')) {
        options.resume = next
        i += 1
      } else {
        options.resume = true
      }
    }
  }
  return options
}
