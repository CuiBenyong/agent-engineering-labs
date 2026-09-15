/**
 * `mca --help` 的正文。本天新增。
 *
 * 它和 README 分工不同：README 回答「这是什么、要不要装」，--help 回答
 * 「已经装了，现在怎么敲」。所以这里一句介绍都不写，全是能直接复制的命令行；
 * 第一屏就给一条**不需要任何配置**就能跑起来的（MOCK=1 那条），
 * 因为读到 --help 的人多半正卡在「它好像没跑起来」上。
 */
export function helpText(): string[] {
  return [
    '用法：mca [选项] [--task "一句话"]',
    '',
    '  不带参数            进入交互式 REPL（输入 /help 看斜杠命令）',
    '  --task "..."        跑一次就退出，适合脚本与 CI；默认只读',
    '  --yes               配合 --task 使用，授权这一次的写操作与命令执行',
    '  --resume[=<id>]     接着上一条会话（不带 id 就是最近那条）',
    '  --sessions          列出磁盘上的会话',
    '  --model <id>        这一次换个模型（优先级高于环境变量与配置文件）',
    '  --base-url <url>    这一次换个网关',
    '  --config            打印当前配置、每个值来自哪一层，然后退出',
    '  --version, -v       打印版本',
    '  --help, -h          打印这段',
    '',
    '环境变量：LLM_BASE_URL / LLM_API_KEY / LLM_MODEL；MOCK=1 走离线剧本不联网。',
    '',
    '先看看它长什么样（不需要任何 key）：',
    '  MOCK=1 mca --task "修一下失败的测试" --yes',
  ]
}
