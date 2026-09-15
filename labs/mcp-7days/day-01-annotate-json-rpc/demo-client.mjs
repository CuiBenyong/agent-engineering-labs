// D1 演示用 MCP 客户端：把 demo-server.mjs 拉起来，跑一轮会话，把双向报文原样打到屏幕上。
// 用法：node demo-client.mjs        （零依赖、不联网）
//       node demo-client.mjs > transcript.txt   把报文存下来慢慢标注
// 许可：MIT
import { spawn } from 'node:child_process'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const child = spawn(process.execPath, [path.join(here, 'demo-server.mjs')], {
  stdio: ['pipe', 'pipe', 'inherit'],
})

const pending = new Map()
readline.createInterface({ input: child.stdout }).on('line', (line) => {
  console.log('\n<-- 服务端 -> 客户端')
  console.log(JSON.stringify(JSON.parse(line), null, 2))
  const msg = JSON.parse(line)
  const resolve = pending.get(msg.id)
  if (resolve) {
    pending.delete(msg.id)
    resolve(msg)
  }
})

let nextId = 1
function send(method, params = {}) {
  const id = nextId++
  const req = {
    jsonrpc: '2.0',
    id,
    method,
    params: {
      ...params,
      _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientInfo': { name: 'd1-demo-client', version: '0.1.0' },
        'io.modelcontextprotocol/clientCapabilities': {},
      },
    },
  }
  console.log('\n--> 客户端 -> 服务端')
  console.log(JSON.stringify(req, null, 2))
  child.stdin.write(JSON.stringify(req) + '\n')
  return new Promise((resolve) => pending.set(id, resolve))
}

console.log('=== 第 1 轮：server/discover（这一版新增，服务端必须实现）===')
await send('server/discover')

console.log('\n=== 第 2 轮：tools/list ===')
await send('tools/list')

console.log('\n=== 第 3 轮：tools/call（正常）===')
await send('tools/call', { name: 'get_weather', arguments: { city: '上海' } })

console.log('\n=== 第 4 轮：tools/call（工具执行错误，注意 isError 而不是 error）===')
await send('tools/call', { name: 'get_weather', arguments: { city: '火星' } })

console.log('\n=== 第 5 轮：故意漏掉协议版本，看服务端怎么拒绝 ===')
child.stdin.write(
  JSON.stringify({ jsonrpc: '2.0', id: nextId++, method: 'tools/list', params: {} }) + '\n'
)
await new Promise((r) => setTimeout(r, 200))

child.stdin.end()
