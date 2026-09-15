// 把当前目录 package.json 的补丁版本号加一，并把新版本打印出来。
import { readFile, writeFile } from 'node:fs/promises'

const file = 'package.json'
const pkg = JSON.parse(await readFile(file, 'utf8'))
const [major = '0', minor = '0', patch = '0'] = String(pkg.version ?? '0.0.0').split('.')
pkg.version = `${major}.${minor}.${Number(patch) + 1}`
await writeFile(file, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
console.log(`版本号已升到 ${pkg.version}`)
