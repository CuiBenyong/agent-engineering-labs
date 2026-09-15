/**
 * 生成式界面：模型决定界面长什么样。
 *
 * 三种范式，控制权从前端一路让渡到模型：
 *
 *   范式一  静态生成式：前端定组件，模型只选哪个 + 填数据
 *   范式二  声明式：模型返回一份界面描述，前端按自己的规则渲染
 *   范式三  开放式：模型直接产出界面代码 —— 本课**不实现**，只讲为什么不该用
 *
 * 本文件实现前两种，并把「未注册类型」的兜底做扎实——
 * 那是生成式界面在生产里最常见的失败点。
 */

// ---------- 范式一：静态生成式 ----------

/**
 * 组件规格：模型只能从注册表里挑一个名字，再给一份数据。
 * 它没有任何办法让前端渲染注册表之外的东西，这是这一范式的全部安全性来源。
 */
export type ComponentSpec = {
  component: string
  props: Record<string, unknown>
}

export type RegistryEntry = {
  /** 校验并归一化 props；返回 null 表示这份数据不合法 */
  validate: (props: Record<string, unknown>) => Record<string, unknown> | null
  /** 给模型看的说明，会进 system prompt。写清楚才能让它选对 */
  description: string
}

export type Registry = Record<string, RegistryEntry>

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/**
 * 本课的注册表。三个组件覆盖了聊天里最常见的三种结构化输出。
 *
 * 每个组件都自己校验 props：模型给的数据**不可信**，不是因为它恶意，
 * 而是因为它会犯错——少个字段、类型给错、数组给成字符串，都很常见。
 */
export const REGISTRY: Registry = {
  metric: {
    description: '展示一个关键指标，props: label(字符串) value(数字) unit(可选字符串)',
    validate: (p) => {
      const label = str(p.label)
      const value = num(p.value)
      if (label === null || value === null) return null
      return { label, value, unit: str(p.unit) ?? '' }
    },
  },

  choices: {
    description: '让用户从几个选项里挑一个，props: question(字符串) options(字符串数组)',
    validate: (p) => {
      const question = str(p.question)
      const options = Array.isArray(p.options)
        ? p.options.map(str).filter((s): s is string => s !== null)
        : []
      if (question === null || options.length === 0) return null
      return { question, options }
    },
  },

  table: {
    description: '展示一张表格，props: columns(字符串数组) rows(二维字符串数组)',
    validate: (p) => {
      const columns = Array.isArray(p.columns)
        ? p.columns.map(str).filter((s): s is string => s !== null)
        : []
      const rows = Array.isArray(p.rows)
        ? p.rows.filter(Array.isArray).map((r) => r.map((c) => String(c)))
        : []
      if (columns.length === 0) return null
      return { columns, rows }
    },
  },
}

export type ResolvedComponent =
  | { ok: true; component: string; props: Record<string, unknown> }
  /** 组件名不在注册表里 */
  | { ok: false; reason: 'unknown-component'; component: string }
  /** 组件名认识，但数据不合法 */
  | { ok: false; reason: 'invalid-props'; component: string }

/**
 * 解析一份组件规格。
 *
 * 两种失败要分开报，因为它们对开发者的含义完全不同：
 * 未注册组件说明模型选了个不存在的东西（通常是 prompt 里的说明不够清楚，
 * 或者上游加了新组件而前端没跟上）；数据不合法说明组件名对但字段错了。
 * 合并成一个「渲染失败」会让排查无从下手。
 */
export function resolveComponent(
  spec: ComponentSpec,
  registry: Registry = REGISTRY
): ResolvedComponent {
  const entry = registry[spec.component]
  if (!entry) {
    return { ok: false, reason: 'unknown-component', component: spec.component }
  }
  const props = entry.validate(spec.props ?? {})
  if (props === null) {
    return { ok: false, reason: 'invalid-props', component: spec.component }
  }
  return { ok: true, component: spec.component, props }
}

/** 注册表说明，拼进 system prompt 用。模型选错组件多半是因为这段写得不清楚。 */
export function describeRegistry(registry: Registry = REGISTRY): string {
  return Object.entries(registry)
    .map(([name, entry]) => `- ${name}: ${entry.description}`)
    .join('\n')
}

// ---------- 范式二：声明式 ----------

/**
 * 界面描述：模型返回一棵节点树，前端按自己的规则渲染。
 *
 * 比静态范式自由（能组合布局），但仍然是**数据不是代码**——
 * 这是它和开放式范式的根本区别，也是它可以安全使用的原因。
 */
export type UiNode = {
  type: string
  text?: string
  children?: UiNode[]
}

/** 允许出现在界面描述里的节点类型。白名单之外一律拒绝。 */
export const ALLOWED_NODE_TYPES = ['stack', 'row', 'heading', 'text', 'badge', 'divider'] as const

export type AllowedNodeType = (typeof ALLOWED_NODE_TYPES)[number]

const ALLOWED = new Set<string>(ALLOWED_NODE_TYPES)

/** 嵌套深度上限：模型可能产出深到爆栈的树，这不一定是恶意，递归生成跑偏就够了。 */
export const MAX_DEPTH = 6

export type SanitizedNode = {
  type: AllowedNodeType
  text?: string
  children: SanitizedNode[]
  /** 这个节点上发生过什么问题，用来在界面上如实显示 */
  issue?: 'unknown-type' | 'too-deep'
}

/**
 * 清洗界面描述。
 *
 * 原则：**遇到不认识的东西降级，而不是整棵树拒绝**。
 * 模型产出的树里有一个节点类型不认识，不该让整个回答变成一片空白——
 * 其余部分通常仍然有用。
 */
export function sanitizeNode(node: UiNode, depth = 0): SanitizedNode {
  if (depth >= MAX_DEPTH) {
    return { type: 'text', text: '（内容层级过深，已省略）', children: [], issue: 'too-deep' }
  }

  if (!ALLOWED.has(node.type)) {
    // 降级成纯文本：把文字内容保住，把结构丢掉。
    return {
      type: 'text',
      text: node.text ?? `（不支持的组件：${node.type}）`,
      children: [],
      issue: 'unknown-type',
    }
  }

  const children = Array.isArray(node.children)
    ? node.children.map((child) => sanitizeNode(child, depth + 1))
    : []

  return {
    type: node.type as AllowedNodeType,
    text: typeof node.text === 'string' ? node.text : undefined,
    children,
  }
}

/**
 * 流式中途的部分对象。
 *
 * 结构化输出也是逐 token 生成的，所以你会在中途拿到半截 JSON。
 * 和 D3 的工具参数一个道理：能 parse 就渲染，不能就先显示占位，
 * **绝不把半截 JSON 原文显示给用户**。
 */
export function tryParsePartial(raw: string): ComponentSpec | null {
  if (!raw.trim()) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as ComponentSpec).component === 'string'
    ) {
      const spec = parsed as ComponentSpec
      return { component: spec.component, props: spec.props ?? {} }
    }
    return null
  } catch {
    return null
  }
}
