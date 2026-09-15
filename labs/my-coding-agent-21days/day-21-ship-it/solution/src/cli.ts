/**
 * 命令行参数。来自 D15，本天扩写了一次：多了七个开关。
 *
 * 本天新增的部分（`--version` `--help` `--config` `--task` `--yes`
 * `--model` `--base-url`）都是「装到别人机器上」之后才需要的东西：
 * 前二十天唯一的用户知道怎么改环境变量、也不需要问它是哪个版本。
 *
 * 仍然不引 commander / yargs：整个解析器到今天也才八十行，而引进来的那点便利
 * 要拿一个运行时依赖换——一个全局安装的 CLI 每多一个依赖，就多一份
 * 「用户那边装不上」的概率。
 *
 * 原 D15 说明：
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
  /** 以下七个本天新增 */
  version?: boolean
  help?: boolean
  config?: boolean
  task?: string
  yes?: boolean
  model?: string
  baseUrl?: string
}

/** 需要跟一个值的开关。写成表而不是一串 if，加开关时只改这里 */
const VALUED: Record<string, keyof CliOptions> = {
  '--task': 'task',
  '--model': 'model',
  '--base-url': 'baseUrl',
}

export function parseArgv(argv: string[]): CliOptions {
  const options: CliOptions = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string
    if (arg === '--sessions') {
      options.sessions = true
      continue
    }
    if (arg === '--version' || arg === '-v') {
      options.version = true
      continue
    }
    if (arg === '--help' || arg === '-h') {
      options.help = true
      continue
    }
    if (arg === '--config') {
      options.config = true
      continue
    }
    if (arg === '--yes' || arg === '-y') {
      options.yes = true
      continue
    }
    // --key=value 与 --key value 两种写法都收：前者在脚本里不容易写错，
    // 后者是人手敲的习惯。只支持一种的 CLI 会被投诉，而代价只有这四行
    const valued = Object.keys(VALUED).find((key) => arg === key || arg.startsWith(`${key}=`))
    if (valued) {
      const inline = arg.startsWith(`${valued}=`) ? arg.slice(valued.length + 1) : undefined
      const next = inline ?? argv[i + 1]
      if (inline === undefined && next !== undefined && !next.startsWith('--')) i += 1
      if (next !== undefined && !next.startsWith('--')) {
        options[VALUED[valued] as 'task'] = next
      }
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
