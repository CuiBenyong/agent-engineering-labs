/**
 * 今天的离线剧本。每天都会按当天要展示的现象重写这个文件，所以它不冻结。
 *
 * 规则：按最后一条用户消息选场景，不要按轮数递增——否则注入故障后剧本就错位了。
 */

export interface Scene {
  name: string
  text: string
}

const SCENES: Array<{ match: RegExp; scene: Scene }> = [
  {
    match: /测试|test/i,
    scene: {
      name: 'tests',
      text:
        '现在我还没有任何工具，看不到你的仓库，所以只能凭空猜。' +
        '第三天我会拿到读文件、找文件、搜内容三件工具，第四天才能真的跑测试。',
    },
  },
  {
    match: /你是谁|who are you/i,
    scene: {
      name: 'identity',
      text: '我是 mca，一个正在被你亲手造出来的终端 Coding Agent。今天我只会说话，还不会动手。',
    },
  },
]

const FALLBACK: Scene = {
  name: 'fallback',
  text:
    '这是离线剧本的回答：去掉 MOCK=1 并配好 LLM_API_KEY 就会连真模型。' +
    '今天这一层只做三件事——把输入分成命令与对话、把消息交给网关、把增量打回终端。',
}

export function pickScene(userText: string): Scene {
  return SCENES.find((entry) => entry.match.test(userText))?.scene ?? FALLBACK
}
