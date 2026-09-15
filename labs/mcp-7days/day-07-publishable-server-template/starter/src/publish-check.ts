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
  // 练习 4：现在只查了两个字段存在与否，等于什么都没查。
  // 按下面这张表补全，每一条都对应一个「发出去之后改不了」的错误：
  //   - bin 缺失：用户没法用 npx 起你的服务端
  //   - files 里没有 dist：发出去的包缺产物
  //   - mcpName 缺失或与 server.json 的 name 不一致：注册表用它做归属校验，不一致会被拒收
  //   - server.json 的 name 不是反向域名加斜杠的形式（例如 io.github.用户名/docs）
  //   - server.json 的 version 是一个版本范围（^1.2.3、1.x 这类），注册表明确禁止
  //   - 本地服务端的包版本与 server.json 的 version、packages[0].version 三处不一致
  //   - packages[0].identifier 与包名不一致
  // 顶上的 RANGE 正则是给版本范围那条用的。
  if (!pkg.name) problems.push('package.json 缺 name')
  if (!server.version) problems.push('server.json 缺 version')
  return problems
}
