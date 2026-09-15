/**
 * 「什么不该写进记忆」的那道闸。本天新增，是今天唯一一个**宁可误杀也要拦**的地方。
 *
 * 三类内容各有一条不同性质的理由，所以三类的处理也不一样：
 *
 *   1. **密钥类**（token、私钥、连接串）——安全问题。
 *      记忆目录是明文的、常驻的、每一轮都往网关发一遍的。一条记住的密钥
 *      等于把它抄进了每一次请求。**这一类拦得最死，而且拒绝话术里不许回显原文。**
 *   2. **临时结论**（「现在测试是红的」「刚才那次跑失败了」）——分类问题。
 *      它是过程不是事实，过程归第七天的会话日志。写进记忆的后果是：
 *      三天后它带着一条早就不成立的「现在」进上下文，而且它自己说不清是什么时候的现在。
 *   3. **代码里已经写着的事**（「divide 在 src/calc.js 里」）——预算问题。
 *      这一类不是错的，是**不值得**：读一次文件就知道的事，占着常驻额度每一轮重发。
 *      记忆该存的是「读代码读不出来的东西」——踩过的坑、约定、失败过的做法。
 *
 * 后两类是软拦：拒绝并说清该往哪儿放。第一类是硬拦，而且拦下来之后要提醒用户
 * **那个 key 已经泄露在你的输入历史里了，去轮换它**——只说「不能记」是没尽到责任的。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { REPO_DIR } from '../seed.js'

export type RedactReason = 'secret' | 'transient' | 'in-code'

export interface RedactVerdict {
  allowed: boolean
  reason?: RedactReason
  /** 要回灌给模型、也要打给用户的一句话。**绝不包含被拦下的原文** */
  note: string
  /** 命中的是哪一条规则，只用于终端与自检 */
  rule?: string
}

/**
 * 密钥类的形状。**按形状拦，不按变量名拦**——「我的 key 是 xxx」里那个 xxx 才是要拦的东西，
 * 而「key 要放进环境变量不要写死」这句话里一个密钥都没有，它是条好记忆。
 *
 * 每条规则都是「前缀 + 足够长的随机串」这种结构。为什么这样够用：
 * 真正危险的字符串都是给机器读的，所以它们都长、都随机、都带家族前缀。
 * 一条读得懂的中文句子撞不上这些形状。
 */
const SECRET_RULES: Array<{ rule: string; pattern: RegExp }> = [
  // TODO(2a)：把密钥类的形状补齐。**按形状拦，不按变量名拦** ——
  // 「我的 key 是 sk-…」里那个长串才是要拦的东西，而「key 要放进环境变量不要写死」
  // 这句话里一个密钥都没有，它是条好记忆。
  //
  // 至少覆盖六类：带家族前缀的 token（sk- / ghp_ / xoxb- 之类加一长串字母数字）、
  // 云厂商 access key（AKIA / AIza 开头）、PEM 私钥块的起始行、JWT（三段点分的
  // base64url）、带密码的连接串（协议://用户:口令@主机）、以及「赋值给密钥类变量的长串」。
  //
  // 为什么这些形状够用：真正危险的字符串都是给机器读的，所以它们都长、都随机、
  // 都带家族前缀，而一条读得懂的中文句子撞不上它们。
  //
  // 补完之后回头看下面那句拒绝话术：**它一个字的原文都不许回显。**
  // 把被拦下的密钥抄进错误信息，等于把它写进了另一份日志。
]

/**
 * 临时结论的形状：**带时间指示词的状态描述。**
 *
 * 判据是「这句话里有一个只在说话那一刻成立的时间锚」。「现在测试是红的」里的「现在」
 * 三天后指的是另一个时刻，而这条记忆自己不知道这件事。
 *
 * 这一条一定会有误杀——「这个仓库现在还在用 CommonJS」其实是条不错的记忆。
 * 所以拒绝话术必须给出改法（去掉时间词、把它写成一条不依赖「什么时候」的事实），
 * **一条不给出路的拦截会让用户直接放弃这个功能。**
 */
const TRANSIENT_WORDS = ['现在', '刚才', '这一轮', '这次', '暂时', '目前正在', '还没跑完', '待会']
const STATE_WORDS = ['红的', '绿的', '失败', '成功', '在跑', '跑完', '通过了', '没通过', '正在']

/**
 * 代码里已经写着的判据：正文里点了某个仓库文件的名字，而那句话里的**代码片段**
 * 确实在那个文件里。
 *
 * 片段的长度下限是这条规则唯一的旋钮，而它必须给得比直觉大。给 4 的时候
 * 「测试只能用 node --test」会被 `test` 命中 package.json 而误杀——`test` 在
 * 任何一个 package.json 里都出现。给 8 之后，命中的只能是标识符、命令、路径这类
 * **一眼就是代码的东西**，而它们出现在句子里基本就意味着「这句话在复述代码」。
 */
const CODE_FACT_MIN_MATCH = 8

export interface RedactOptions {
  source: 'command' | 'model'
  /** 查「代码里已经写着」时读哪个仓库。默认沙盒仓库 */
  cwd?: string
}

export async function redact(text: string, options: RedactOptions): Promise<RedactVerdict> {
  for (const { rule, pattern } of SECRET_RULES) {
    if (!pattern.test(text)) continue
    return {
      allowed: false,
      reason: 'secret',
      rule,
      // 注意这句话里一个字的原文都没有。**回显被拦下的密钥等于把它写进了另一份日志**
      note:
        `这条内容里有密钥的形状（${rule}），已经拒绝写入记忆，原文不会被记录到任何地方。` +
        '记忆目录是明文的、每一轮都会发给模型，密钥一旦记进去等于抄进了每一次请求。' +
        '正确的做法是把它放进环境变量，记忆里只写「这个项目需要哪个环境变量」。' +
        '另外：它已经出现在这次输入里了，请把那个凭据轮换掉。',
    }
  }

  const timeWord = TRANSIENT_WORDS.find((word) => text.includes(word))
  const stateWord = STATE_WORDS.find((word) => text.includes(word))
  if (timeWord && stateWord) {
    return {
      allowed: false,
      reason: 'transient',
      rule: `${timeWord} + ${stateWord}`,
      note:
        `这条内容像是一个临时结论（出现了「${timeWord}」和「${stateWord}」），没有写进记忆。` +
        '记忆存的是下一次还成立的事实，这一次的进展归会话日志。' +
        '如果它其实是条长期事实，请去掉时间词重写一遍，例如把「现在测试是红的」' +
        '写成「除零那个用例一直没人修」。',
    }
  }

  const inCode = await findInCode(text, options.cwd ?? REPO_DIR)
  if (inCode) {
    return {
      allowed: false,
      reason: 'in-code',
      rule: inCode.file,
      note:
        `这条内容在 ${inCode.file} 里已经写着了（命中「${inCode.excerpt}」），没有写进记忆。` +
        '读一次文件就知道的事不值得占常驻的记忆额度——它每一轮都会重发一遍。' +
        '记忆该存的是读代码读不出来的东西：踩过的坑、口头约定、试过但不行的做法。',
    }
  }

  return { allowed: true, note: '' }
}

/**
 * 「这句话在代码里已经写着了吗」。
 *
 * 做法故意很笨：**只有这句话里明确提到了某个仓库文件，才去读那个文件。**
 * 不做全仓库搜索，两个理由——全搜很慢，而且全搜的命中率高得离谱：
 * 任何一句提到 `divide` 的话都会在 `calc.js` 里命中，于是这条闸变成了「什么都不许记」。
 *
 * 比的是**英数片段**而不是整句：中文说明句永远不会出现在源码里，
 * 能对上的只可能是那句话里代码的那一半。
 */
async function findInCode(
  text: string,
  cwd: string
): Promise<{ file: string; excerpt: string } | null> {
  // TODO(2b)：判断这句话是不是在复述代码。
  //
  // 做法故意要很笨：**只有这句话里明确点了某个仓库文件的名字，才去读那个文件。**
  // 不做全仓库搜索——全搜很慢，而且命中率高得离谱：任何一句提到 divide 的话
  // 都会在 calc.js 里命中，于是这条闸变成了「什么都不许记」。
  //
  // 命中的判据是「这句话里有一段长度不小于 CODE_FACT_MIN_MATCH 的英数片段
  // 出现在那个文件里」。两处容易写错：
  //   ① 比的必须是英数片段而不是整句——中文说明句永远不会出现在源码里
  //   ② 要排除被点名的那个路径本身，「src/calc.js 里」不等于在复述代码
  //
  // 长度下限那个常数是这条规则唯一的旋钮，而它必须给得比直觉大：
  // 给 4 的时候「测试只能用 node --test」会被 test 命中 package.json 而误杀。
  void text
  void cwd
  return null
}
