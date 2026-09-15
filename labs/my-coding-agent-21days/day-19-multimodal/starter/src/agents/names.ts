/**
 * 派发工具的名字。单独一个文件只为打断一条循环依赖：
 * run.ts 要知道「哪个名字永远不许进子 Agent 的白名单」，
 * 而 tool.ts 要用 run.ts 跑子 Agent——名字放在任何一边都会转成环。
 */
export const DISPATCH_TOOL = 'dispatch_agents'
