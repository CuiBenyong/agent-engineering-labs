/**
 * JSON Patch（RFC 6902）的最小实现。
 *
 * 为什么自己写：本课零运行时依赖，而且这东西的难点不在实现，
 * 在于**打不上的时候怎么办**——那才是共享状态真正的工程问题。
 *
 * 支持 add / remove / replace / test 四种操作。move / copy 在 Agent 场景里
 * 几乎用不到（服务端算 diff 时通常只产出前三种），本课不实现，
 * 遇到就当作打不上处理，走快照恢复的路径，而不是假装成功。
 */

export type JsonPatchOperation = {
  op: 'add' | 'remove' | 'replace' | 'move' | 'copy' | 'test'
  path: string
  value?: unknown
  from?: string
}

export class PatchFailure extends Error {
  constructor(
    message: string,
    readonly operation: JsonPatchOperation
  ) {
    super(message)
    this.name = 'PatchFailure'
  }
}

/**
 * 解析 JSON Pointer。
 * 规范规定 `~1` 代表 `/`、`~0` 代表 `~`，顺序不能反——
 * 先还原 `~1` 再还原 `~0`，否则 `~01` 会被错误地解成 `/`。
 */
function parsePointer(pointer: string): string[] {
  if (pointer === '') return []
  if (!pointer.startsWith('/')) {
    throw new Error(`不是合法的 JSON Pointer：${pointer}`)
  }
  return pointer
    .slice(1)
    .split('/')
    .map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'))
}

type Container = Record<string, unknown> | unknown[]

function isContainer(value: unknown): value is Container {
  return typeof value === 'object' && value !== null
}

/** 深拷贝：补丁必须在副本上做，失败时才能原样回退。 */
function clone<T>(value: T): T {
  return structuredClone(value)
}

function getParent(
  root: unknown,
  segments: string[],
  op: JsonPatchOperation
): { parent: Container; key: string } {
  let current: unknown = root

  for (let i = 0; i < segments.length - 1; i += 1) {
    if (!isContainer(current)) {
      throw new PatchFailure(`路径 ${op.path} 在第 ${i} 段处不存在`, op)
    }
    const segment = segments[i]
    current = Array.isArray(current)
      ? current[Number(segment)]
      : (current as Record<string, unknown>)[segment]
  }

  if (!isContainer(current)) {
    throw new PatchFailure(`路径 ${op.path} 的父节点不是对象或数组`, op)
  }

  return { parent: current, key: segments[segments.length - 1] }
}

function applyOne(root: unknown, op: JsonPatchOperation): unknown {
  const segments = parsePointer(op.path)

  // 空路径表示整份文档
  if (segments.length === 0) {
    if (op.op === 'replace' || op.op === 'add') return op.value
    throw new PatchFailure(`不支持对根路径执行 ${op.op}`, op)
  }

  const { parent, key } = getParent(root, segments, op)

  if (Array.isArray(parent)) {
    // 数组的 `-` 表示末尾追加
    const index = key === '-' ? parent.length : Number(key)
    if (!Number.isInteger(index) || index < 0) {
      throw new PatchFailure(`数组下标非法：${key}`, op)
    }

    switch (op.op) {
      case 'add':
        if (index > parent.length) throw new PatchFailure(`下标越界：${index}`, op)
        parent.splice(index, 0, op.value)
        return root
      case 'remove':
        if (index >= parent.length) throw new PatchFailure(`下标越界：${index}`, op)
        parent.splice(index, 1)
        return root
      case 'replace':
        if (index >= parent.length) throw new PatchFailure(`下标越界：${index}`, op)
        parent[index] = op.value
        return root
      case 'test':
        if (JSON.stringify(parent[index]) !== JSON.stringify(op.value)) {
          throw new PatchFailure(`test 失败：${op.path}`, op)
        }
        return root
      default:
        throw new PatchFailure(`不支持的操作：${op.op}`, op)
    }
  }

  const obj = parent as Record<string, unknown>

  switch (op.op) {
    case 'add':
    case 'replace':
      // 规范里 replace 要求路径必须已存在。这条值得严格执行：
      // 服务端发来 replace 而本地没有那个键，说明两边状态已经不一致了，
      // 宽容地当 add 处理会把不一致藏起来，直到某天以更难查的形式爆出来。
      // 【练习 2】replace 到一个不存在的键，应该成功还是失败？
      //
      // 想清楚：宽容地当 add 处理会发生什么。
      // 提示——服务端发来 replace 说明它认为那个键存在，而本地没有，
      // 这本身就是两边状态已经不一致的信号。
      // TODO
      obj[key] = op.value
      return root
    case 'remove':
      if (!(key in obj)) throw new PatchFailure(`remove 的路径不存在：${op.path}`, op)
      delete obj[key]
      return root
    case 'test':
      if (JSON.stringify(obj[key]) !== JSON.stringify(op.value)) {
        throw new PatchFailure(`test 失败：${op.path}`, op)
      }
      return root
    default:
      throw new PatchFailure(`不支持的操作：${op.op}`, op)
  }
}

export type PatchResult =
  { ok: true; state: unknown } | { ok: false; error: PatchFailure; state: unknown }

/**
 * 应用一组补丁。
 *
 * 两条关键性质：
 * 1. **全有或全无**。补丁在副本上依次执行，中途任何一条失败都丢弃整个副本、
 *    返回原状态。半应用的状态比不应用更糟——你会得到一份谁都没见过的数据。
 * 2. **失败不抛异常**，返回失败结果让调用方决定怎么办。共享状态的补丁打不上
 *    是**可预期**的（丢包、乱序、版本漂移），不是程序 bug，
 *    正确反应是去请求一份完整快照重新对齐，而不是让界面崩掉。
 */
export function applyPatch(state: unknown, operations: JsonPatchOperation[]): PatchResult {
  // 【练习 1】应用一组补丁，保证两条性质：
  //
  //   a) 全有或全无：在副本上依次执行，中途任何一条失败就丢弃整个副本、
  //      返回**原状态**。半应用的状态比不应用更糟——你会得到一份谁都没见过的数据。
  //   b) 失败不抛异常：返回失败结果让调用方决定怎么办。补丁打不上是**可预期**的
  //      （丢包、乱序、版本漂移），不是程序 bug。
  //
  // 自检里有两条断言分别盯这两点。
  void operations
  throw new Error('TODO: 实现 applyPatch')
}
