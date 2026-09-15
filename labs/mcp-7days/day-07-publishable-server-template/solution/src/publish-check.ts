// 发布前的静态核对。它挡的不是 bug，是「发出去之后改不了」的那一类错误：
// 注册表里同一个版本号只能发一次，元数据发布之后不能改。
export interface PackageJson {
  name?: string
  version?: string
  bin?: Record<string, string> | string
  files?: string[]
  mcpName?: string
}

export interface ServerJson {
  name?: string
  version?: string
  packages?: { registryType?: string; identifier?: string; version?: string }[]
}

const RANGE = /[\^~]|>=|<=|>|<|\bx\b|\*|\|\|| - /

/** 返回问题清单；空数组表示可以发。 */
export function checkPublish(pkg: PackageJson, server: ServerJson): string[] {
  const problems: string[] = []
  const first = server.packages?.[0]

  if (!pkg.name) problems.push('package.json 缺 name')
  if (!pkg.version) problems.push('package.json 缺 version')
  if (!pkg.bin) problems.push('package.json 缺 bin：没有可执行入口，用户没法用 npx 起你的服务端')
  if (!pkg.files?.includes('dist'))
    problems.push('package.json 的 files 里没有 dist：发出去的包会缺产物')

  // 注册表靠这个字段确认「这个 npm 包确实是这个服务端」，缺了会直接拒收
  if (!pkg.mcpName) problems.push('package.json 缺 mcpName：注册表用它做归属校验')
  if (pkg.mcpName && server.name && pkg.mcpName !== server.name) {
    problems.push(`mcpName（${pkg.mcpName}）与 server.json 的 name（${server.name}）必须一致`)
  }
  if (server.name && !/^[a-z0-9.-]+\/[A-Za-z0-9._-]+$/.test(server.name)) {
    problems.push('server.json 的 name 要用反向域名加斜杠的形式，例如 io.github.用户名/docs')
  }

  if (!server.version) problems.push('server.json 缺 version')
  if (server.version && RANGE.test(server.version)) {
    problems.push(`server.json 的 version（${server.version}）看起来是一个版本范围，注册表会拒收`)
  }
  if (pkg.version && server.version && pkg.version !== server.version) {
    problems.push(
      `本地服务端应当让 server.json 的 version（${server.version}）与包版本（${pkg.version}）对齐`
    )
  }
  if (first && pkg.name && first.identifier !== pkg.name) {
    problems.push(
      `server.json 里 packages[0].identifier（${String(first.identifier)}）应当等于包名（${pkg.name}）`
    )
  }
  if (first && pkg.version && first.version !== pkg.version) {
    problems.push('server.json 里 packages[0].version 应当与包版本一致')
  }
  return problems
}
