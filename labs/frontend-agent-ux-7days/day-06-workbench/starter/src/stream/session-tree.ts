/**
 * 会话树：把线性的聊天历史换成一棵可以分叉的树。
 *
 * 为什么需要它：编辑重发和「换个说法再试一次」这两个需求，在线性历史里
 * 只能靠**丢掉后面的内容**来实现。用户改了三轮前的一句话，后面十几轮全没了，
 * 而他往往只是想对比两种问法的结果。
 *
 * 树的模型下，编辑重发 = 在同一个父节点下新开一个分支，旧分支完整保留。
 */

export type NodeId = string

export type SessionNode = {
  id: NodeId
  parentId: NodeId | null
  /** 这一轮用户说了什么。根节点为 null */
  userText: string | null
  /** 这一轮产生的时间线项的 id，具体内容存在各自的表里 */
  items: string[]
  children: NodeId[]
  createdAt: number
}

export type SessionTree = {
  nodes: Record<NodeId, SessionNode>
  rootId: NodeId
  /** 当前处在哪个叶子上。渲染时从它沿 parentId 回溯到根 */
  activeId: NodeId
}

export function createTree(): SessionTree {
  const rootId = 'root'
  return {
    nodes: {
      [rootId]: {
        id: rootId,
        parentId: null,
        userText: null,
        items: [],
        children: [],
        createdAt: Date.now(),
      },
    },
    rootId,
    activeId: rootId,
  }
}

let seq = 0
function nextId(): NodeId {
  seq += 1
  return `n${seq}`
}

/** 在当前活动节点下追加一轮。正常发消息走这里。 */
export function appendTurn(tree: SessionTree, userText: string): SessionTree {
  return branchFrom(tree, tree.activeId, userText)
}

/**
 * 从指定节点分叉出一个新分支。编辑重发走这里。
 *
 * 关键：**旧分支不删**。它仍然挂在同一个父节点下，用户随时能切回去对比。
 * 这正是树相对线性历史的全部价值。
 */
export function branchFrom(tree: SessionTree, parentId: NodeId, userText: string): SessionTree {
  const parent = tree.nodes[parentId]
  if (!parent) return tree

  const id = nextId()
  const node: SessionNode = {
    id,
    parentId,
    userText,
    items: [],
    children: [],
    createdAt: Date.now(),
  }

  // 【练习 1】把新节点挂到父节点下。
  //
  // 最关键的一点：父节点原有的 children **不能丢**。
  // 丢了就退化成线性历史，编辑重发会把旧分支删掉，
  // 而用户往往只是想对比两种问法的结果。
  void node
  return tree
}

/** 编辑某一轮并重发：从**它的父节点**分叉，等于替换那一轮。 */
export function editAndResend(tree: SessionTree, nodeId: NodeId, newText: string): SessionTree {
  const node = tree.nodes[nodeId]
  if (!node || node.parentId === null) return tree
  return branchFrom(tree, node.parentId, newText)
}

/** 往当前活动节点里记一个时间线项。 */
export function addItem(tree: SessionTree, itemId: string): SessionTree {
  const node = tree.nodes[tree.activeId]
  if (!node) return tree
  // 去重：同一个 id 不重复记，续播场景下会重复收到同样的事件
  if (node.items.includes(itemId)) return tree
  return {
    ...tree,
    nodes: { ...tree.nodes, [node.id]: { ...node, items: [...node.items, itemId] } },
  }
}

/** 从根到活动叶子的那条路径。渲染的就是它。 */
export function activePath(tree: SessionTree): SessionNode[] {
  const path: SessionNode[] = []
  let cursor: SessionNode | undefined = tree.nodes[tree.activeId]
  while (cursor) {
    path.unshift(cursor)
    cursor = cursor.parentId ? tree.nodes[cursor.parentId] : undefined
  }
  return path
}

/** 切换到另一个分支（通常是某个兄弟节点的子树末端）。 */
export function switchBranch(tree: SessionTree, nodeId: NodeId): SessionTree {
  if (!tree.nodes[nodeId]) return tree
  // 切到那个分支最深的一个叶子，而不是停在中间
  let cursor = tree.nodes[nodeId]
  while (cursor.children.length > 0) {
    cursor = tree.nodes[cursor.children[cursor.children.length - 1]]
  }
  return { ...tree, activeId: cursor.id }
}

/** 某个节点有几个兄弟分支，当前是第几个。界面上显示「2 / 3」用。 */
export function branchInfo(
  tree: SessionTree,
  nodeId: NodeId
): { index: number; total: number; siblings: NodeId[] } {
  const node = tree.nodes[nodeId]
  if (!node || node.parentId === null) return { index: 0, total: 1, siblings: [] }
  const parent = tree.nodes[node.parentId]
  if (!parent) return { index: 0, total: 1, siblings: [] }
  return {
    index: parent.children.indexOf(nodeId),
    total: parent.children.length,
    siblings: parent.children,
  }
}
